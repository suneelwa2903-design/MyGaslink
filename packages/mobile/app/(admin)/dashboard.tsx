import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApiQuery } from '../../src/hooks/useApi';
import { useAuthStore } from '../../src/stores/authStore';
import { useTheme } from '../../src/theme';
import { DateInput } from '../../src/components/ui';
// STAGE-A A6: PendingAction type import dropped — the PA section/query were
// both removed from the dashboard, so the type is no longer referenced.
import type { DashboardStats, OverdueCallListEntry } from '@gaslink/shared';

// ─── Briefing row types ──────────────────────────────────────────────────────

interface InventorySummaryRow {
  summaryId?: string;
  cylinderTypeId: string;
  cylinderTypeName?: string;
  closingFulls: number;
  closingEmpties: number;
}

interface ThresholdAlertRow {
  cylinderTypeId: string;
  cylinderTypeName: string;
  currentStock: number;
  level: 'warning' | 'critical';
  threshold: number;
}

// ─── Theme colors ────────────────────────────────────────────────────────────

const ACCENT = {
  red: '#dc2626',
  navy: '#1e3a5f',
  green: '#10b981',
  orange: '#f59e0b',
  blue: '#3b82f6',
  purple: '#8b5cf6',
} as const;

// ─── Severity badge colors ───────────────────────────────────────────────────

const SEVERITY_COLORS: Record<string, { bg: string; text: string }> = {
  critical: { bg: '#fef2f2', text: '#dc2626' },
  high: { bg: '#fff7ed', text: '#ea580c' },
  medium: { bg: '#fffbeb', text: '#d97706' },
  low: { bg: '#eff6ff', text: '#3b82f6' },
};

const SEVERITY_COLORS_DARK: Record<string, { bg: string; text: string }> = {
  critical: { bg: 'rgba(220, 38, 38, 0.15)', text: '#f87171' },
  high: { bg: 'rgba(234, 88, 12, 0.15)', text: '#fb923c' },
  medium: { bg: 'rgba(217, 119, 6, 0.15)', text: '#fbbf24' },
  low: { bg: 'rgba(59, 130, 246, 0.15)', text: '#60a5fa' },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const currencyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

function formatCurrency(n: number): string {
  return currencyFormatter.format(n);
}

// STAGE-A A4: title-case the time-of-day word ("Good Evening" not
// "Good evening") to match Suneel's preferred greeting style.
function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
}

// STAGE-A A4: title-case a user's stored first-name on display. DB values
// can be all-lowercase ("suneel") or mixed-case; the greeting reads better
// when always rendered "Suneel".
function titleCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function getFormattedDate(): string {
  return new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// STAGE-A A6: timeAgo() helper deleted — its only consumer was the
// Pending Actions section which was removed alongside the PA card.

// ─── KPI card config ─────────────────────────────────────────────────────────

interface KpiCardConfig {
  key: keyof DashboardStats;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  iconBgLight: string;
  iconBgDark: string;
  isCurrency?: boolean;
}

// Each card is tappable and routes to its drill-down screen via
// expo-router. The icon sits inline (left) with the label and value
// stacked beside it — denser than the old icon-above-value layout.
interface KpiCardDest {
  href: Parameters<ReturnType<typeof useRouter>['push']>[0];
}

const KPI_CARDS: (KpiCardConfig & KpiCardDest)[] = [
  {
    key: 'totalCustomers',
    label: 'Customers',
    icon: 'people-outline',
    color: ACCENT.blue,
    iconBgLight: '#eff6ff',
    iconBgDark: 'rgba(59, 130, 246, 0.15)',
    href: '/(admin)/customers',
  },
  {
    key: 'deliveredToday',
    label: 'Delivered',
    icon: 'checkmark-circle-outline',
    color: ACCENT.green,
    iconBgLight: '#ecfdf5',
    iconBgDark: 'rgba(16, 185, 129, 0.15)',
    href: '/(admin)/orders',
  },
  {
    key: 'revenueToday',
    label: 'Revenue Today',
    icon: 'cash-outline',
    color: ACCENT.green,
    iconBgLight: '#ecfdf5',
    iconBgDark: 'rgba(16, 185, 129, 0.15)',
    isCurrency: true,
    href: '/(admin)/reports',
  },
  {
    key: 'totalOutstanding',
    label: 'Outstanding',
    icon: 'wallet-outline',
    color: ACCENT.orange,
    iconBgLight: '#fffbeb',
    iconBgDark: 'rgba(245, 158, 11, 0.15)',
    isCurrency: true,
    href: '/(admin)/collections',
  },
  {
    key: 'overdueInvoices',
    label: 'Overdue Invoices',
    icon: 'warning-outline',
    color: ACCENT.red,
    iconBgLight: '#fef2f2',
    iconBgDark: 'rgba(220, 38, 38, 0.15)',
    href: '/(admin)/finance',
  },
  {
    key: 'inventoryAlerts',
    label: 'Inventory Alerts',
    icon: 'cube-outline',
    color: ACCENT.orange,
    iconBgLight: '#fffbeb',
    iconBgDark: 'rgba(245, 158, 11, 0.15)',
    href: '/(admin)/inventory',
  },
];

// ─── Component ───────────────────────────────────────────────────────────────

// ─── Date helpers (mirror STEP-3A pattern) ───────────────────────────────────

function toIsoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function getDateNDaysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toIsoDate(d);
}

function isValidIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());
}

export default function AdminDashboardScreen() {
  const { dark: isDark, colors: theme } = useTheme();
  const router = useRouter();

  const user = useAuthStore((s) => s.user);
  const firstName = user?.firstName ?? 'Admin';

  // ── Date range state (STEP-3G) ──
  // Default to last 30 days. The current /analytics/dashboard +
  // /analytics/header-metrics endpoints DO NOT consume dateFrom/dateTo
  // server-side (they're fixed to today / all-time) — see PENDING_ITEMS.
  // We still pipe the params through to (a) match web behaviour, (b) be
  // ready when the API adds support, and (c) drive cache busting on the
  // mobile side so the user sees a clear "this is the window I picked".
  const [dateFrom, setDateFrom] = useState<string>(() => getDateNDaysAgoISO(30));
  const [dateTo, setDateTo] = useState<string>(() => toIsoDate(new Date()));

  const dateFromValid = isValidIsoDate(dateFrom);
  const dateToValid = isValidIsoDate(dateTo);
  const datesValid = dateFromValid && dateToValid;
  const queryParams = useMemo(
    () => (datesValid ? { dateFrom, dateTo } : undefined),
    [datesValid, dateFrom, dateTo],
  );

  const resetDateRange = useCallback(() => {
    setDateFrom(getDateNDaysAgoISO(30));
    setDateTo(toIsoDate(new Date()));
  }, []);

  // ── Data queries ──

  const {
    data: stats,
    isLoading: statsLoading,
    isRefetching: statsRefetching,
    refetch: refetchStats,
  } = useApiQuery<DashboardStats>(
    ['admin-dashboard', dateFrom, dateTo],
    '/analytics/dashboard',
    queryParams,
  );

  // STAGE-A A6: PendingActions query removed — the dashboard no longer
  // surfaces PA data (card + section deleted). The PA screen at
  // /(admin)/pending-actions still works on its own.

  // ── Briefing queries (Stock Position, Overdue Calls, Threshold Alerts).
  //   GST Failures + Overview Insights queries dropped 2026-06-01 with
  //   their sections (the dashboard now stops after threshold alerts). ──

  const {
    data: stockSummary,
    refetch: refetchStockSummary,
  } = useApiQuery<InventorySummaryRow[]>(
    ['inventory-summary-today'],
    '/inventory/summary',
  );

  const {
    data: callList,
    refetch: refetchCallList,
  } = useApiQuery<OverdueCallListEntry[]>(
    ['overdue-call-list'],
    '/analytics/overdue-call-list',
  );

  const {
    data: thresholdAlerts,
    refetch: refetchThresholdAlerts,
  } = useApiQuery<ThresholdAlertRow[]>(
    ['inventory-threshold-alerts'],
    '/inventory/threshold-alerts',
  );

  const isRefreshing = statsRefetching;

  const onRefresh = useCallback(() => {
    refetchStats();
    refetchStockSummary();
    refetchCallList();
    refetchThresholdAlerts();
  }, [
    refetchStats,
    refetchStockSummary,
    refetchCallList,
    refetchThresholdAlerts,
  ]);

  // ── Loading state ──

  if (statsLoading && !stats) {
    return (
      <SafeAreaView edges={['left', 'right']} style={[styles.container, { backgroundColor: theme.bg }]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={ACCENT.blue} />
          <Text style={[styles.loadingText, { color: theme.textSecondary }]}>
            Loading dashboard...
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['left', 'right']} style={[styles.container, { backgroundColor: theme.bg }]}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            tintColor={isDark ? '#94a3b8' : '#64748b'}
            colors={[ACCENT.blue]}
          />
        }
      >
        {/* ── Header greeting ── */}
        <View style={styles.header}>
          <Text style={[styles.greeting, { color: theme.text }]}>
            {getGreeting()}, {titleCase(firstName)}
          </Text>
          <Text style={[styles.dateText, { color: theme.textSecondary }]}>
            {getFormattedDate()}
          </Text>
        </View>

        {/* ── STAGE-C: native DateInput replaces the YYYY-MM-DD text inputs. ── */}
        <View style={styles.dateRangeRow}>
          <View style={styles.dateInputWrap}>
            <DateInput
              value={dateFrom || null}
              onChange={setDateFrom}
              label="From"
              placeholder="From"
            />
          </View>
          <View style={styles.dateInputWrap}>
            <DateInput
              value={dateTo || null}
              onChange={setDateTo}
              label="To"
              placeholder="To"
            />
          </View>
          <TouchableOpacity
            onPress={resetDateRange}
            style={[styles.dateResetButton, { borderColor: theme.cardBorder, backgroundColor: theme.cardBg }]}
            activeOpacity={0.7}
          >
            <Text style={[styles.dateResetText, { color: ACCENT.blue }]}>30d</Text>
          </TouchableOpacity>
        </View>

        {/* KPI cards grid (6 cards, 2 per row, tappable to drill-down).
            Icon sits inline (left) with label + value stacked beside it. */}
        <View style={styles.kpiGrid}>
          {KPI_CARDS.map((card, index) => {
            const rawValue = stats?.[card.key] ?? 0;
            const displayValue = card.isCurrency
              ? formatCurrency(rawValue as number)
              : String(rawValue);

            return (
              <TouchableOpacity
                key={card.key}
                activeOpacity={0.7}
                onPress={() => router.push(card.href)}
                style={[
                  styles.kpiCard,
                  index % 2 === 0 ? styles.kpiCardLeft : styles.kpiCardRight,
                ]}
              >
                <View
                  style={[
                    styles.kpiCardInner,
                    {
                      backgroundColor: theme.cardBg,
                      borderColor: theme.cardBorder,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.kpiIconContainer,
                      {
                        backgroundColor: isDark ? card.iconBgDark : card.iconBgLight,
                        marginBottom: 0,
                      },
                    ]}
                  >
                    <Ionicons name={card.icon} size={22} color={card.color} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.kpiLabel, { color: theme.textSecondary, marginBottom: 2 }]} numberOfLines={1}>
                      {card.label}
                    </Text>
                    <Text
                      style={[styles.kpiValue, { color: theme.text }]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                    >
                      {displayValue}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* STAGE-A A6: Pending Actions section removed entirely from the
            dashboard per Suneel. The PA screen at /(admin)/pending-actions
            is still reachable from elsewhere in the app. */}
        {/* ── STEP-3G: Stock Summary section (admin) ── */}
        {stockSummary && stockSummary.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Stock Position</Text>
              <TouchableOpacity
                onPress={() => router.push('/(admin)/inventory')}
                activeOpacity={0.7}
                style={styles.sectionHeaderLink}
              >
                <Text style={styles.viewAllText}>View all</Text>
                <Ionicons name="chevron-forward" size={14} color={ACCENT.blue} />
              </TouchableOpacity>
            </View>
            <View
              style={[
                styles.sectionContainer,
                { backgroundColor: theme.cardBg, borderColor: theme.cardBorder },
              ]}
            >
              {stockSummary.map((row, index) => (
                <View key={row.cylinderTypeId}>
                  {index > 0 && (
                    <View style={[styles.actionDivider, { backgroundColor: theme.divider }]} />
                  )}
                  <View style={styles.briefingRow}>
                    <Text
                      style={[styles.briefingPrimary, { color: theme.text }]}
                      numberOfLines={1}
                    >
                      {row.cylinderTypeName ?? 'Unknown'}
                    </Text>
                    <Text style={[styles.briefingSecondary, { color: theme.textSecondary }]}>
                      Fulls{' '}
                      <Text style={[styles.briefingNumeric, { color: theme.text }]}>
                        {row.closingFulls}
                      </Text>
                      {'   '}Empties{' '}
                      <Text style={[styles.briefingNumeric, { color: theme.text }]}>
                        {row.closingEmpties}
                      </Text>
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </>
        )}

        {/* ── STEP-3G: Overdue Call List preview (admin) ── */}
        {callList && callList.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Call These Customers</Text>
              <TouchableOpacity
                onPress={() => router.push('/(admin)/collections')}
                activeOpacity={0.7}
                style={styles.sectionHeaderLink}
              >
                <Text style={styles.viewAllText}>View all</Text>
                <Ionicons name="chevron-forward" size={14} color={ACCENT.blue} />
              </TouchableOpacity>
            </View>
            <View
              style={[
                styles.sectionContainer,
                { backgroundColor: theme.cardBg, borderColor: theme.cardBorder },
              ]}
            >
              {callList.slice(0, 5).map((c, index) => (
                <View key={c.customerId}>
                  {index > 0 && (
                    <View style={[styles.actionDivider, { backgroundColor: theme.divider }]} />
                  )}
                  <View style={styles.briefingRow}>
                    <View style={styles.briefingTextCol}>
                      <Text
                        style={[styles.briefingPrimary, { color: theme.text }]}
                        numberOfLines={1}
                      >
                        {c.customerName}
                      </Text>
                      <Text
                        style={[styles.briefingMeta, { color: theme.textMuted }]}
                        numberOfLines={1}
                      >
                        {c.phone} {'·'} {c.overdueInvoiceCount} invoice
                        {c.overdueInvoiceCount === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <View style={styles.briefingRightCol}>
                      <Text style={[styles.briefingAmount, { color: ACCENT.red }]}>
                        {formatCurrency(c.totalOutstanding)}
                      </Text>
                      <View
                        style={[
                          styles.miniBadge,
                          {
                            backgroundColor: isDark
                              ? SEVERITY_COLORS_DARK.critical.bg
                              : SEVERITY_COLORS.critical.bg,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.miniBadgeText,
                            {
                              color: isDark
                                ? SEVERITY_COLORS_DARK.critical.text
                                : SEVERITY_COLORS.critical.text,
                            },
                          ]}
                        >
                          {c.daysOverdue}d overdue
                        </Text>
                      </View>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </>
        )}

        {/* ── STEP-3G: Threshold Alerts (admin) ── */}
        {thresholdAlerts && thresholdAlerts.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Threshold Alerts</Text>
              <TouchableOpacity
                onPress={() => router.push('/(admin)/inventory')}
                activeOpacity={0.7}
                style={styles.sectionHeaderLink}
              >
                <Text style={styles.viewAllText}>View all</Text>
                <Ionicons name="chevron-forward" size={14} color={ACCENT.blue} />
              </TouchableOpacity>
            </View>
            <View
              style={[
                styles.sectionContainer,
                { backgroundColor: theme.cardBg, borderColor: theme.cardBorder },
              ]}
            >
              {thresholdAlerts.map((a, index) => {
                const sevKey = a.level === 'critical' ? 'critical' : 'medium';
                const sevColors = isDark
                  ? SEVERITY_COLORS_DARK[sevKey] ?? SEVERITY_COLORS_DARK.low
                  : SEVERITY_COLORS[sevKey] ?? SEVERITY_COLORS.low;
                return (
                  <View key={a.cylinderTypeId}>
                    {index > 0 && (
                      <View style={[styles.actionDivider, { backgroundColor: theme.divider }]} />
                    )}
                    <View style={styles.briefingRow}>
                      <View style={styles.briefingTextCol}>
                        <Text
                          style={[styles.briefingPrimary, { color: theme.text }]}
                          numberOfLines={1}
                        >
                          {a.cylinderTypeName}
                        </Text>
                        <Text
                          style={[styles.briefingMeta, { color: theme.textMuted }]}
                          numberOfLines={1}
                        >
                          {a.currentStock} fulls (threshold {a.threshold})
                        </Text>
                      </View>
                      <View style={[styles.miniBadge, { backgroundColor: sevColors.bg }]}>
                        <Text style={[styles.miniBadgeText, { color: sevColors.text }]}>
                          {a.level.toUpperCase()}
                        </Text>
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          </>
        )}

        {/* GST Failures + Overview insights sections removed 2026-06-01.
            The 6-card KPI grid + Stock Position + Call These Customers +
            Threshold Alerts are the only sections that survive. */}

        {/* Bottom spacing */}
        <View style={styles.bottomSpacer} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    fontWeight: '500',
  },

  // Header
  header: {
    marginBottom: 20,
    paddingTop: 8,
  },
  greeting: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  dateText: {
    fontSize: 14,
    fontWeight: '400',
    marginTop: 4,
  },

  // KPI Grid
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -6,
    marginBottom: 24,
  },
  kpiCard: {
    width: '50%',
    paddingHorizontal: 6,
    marginBottom: 12,
  },
  kpiCardLeft: {
    paddingRight: 6,
    paddingLeft: 0,
  },
  kpiCardRight: {
    paddingLeft: 6,
    paddingRight: 0,
  },
  kpiCardInner: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
  },
  kpiIconContainer: {
    width: 42,
    height: 42,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  kpiValue: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
    marginBottom: 2,
  },
  kpiLabel: {
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.1,
  },

  // Section header
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  countBadge: {
    backgroundColor: ACCENT.red,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    minWidth: 24,
    alignItems: 'center',
  },
  countBadgeText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },

  // Actions container
  actionsContainer: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  actionsLoading: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  emptyActions: {
    paddingVertical: 32,
    alignItems: 'center',
    gap: 8,
  },
  emptyActionsText: {
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
  },

  // Action card
  actionCard: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  actionDivider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 16,
  },
  actionTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  severityBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  severityBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  actionTime: {
    fontSize: 12,
    fontWeight: '400',
  },
  actionDescription: {
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
    marginBottom: 4,
  },
  actionMeta: {
    fontSize: 12,
    fontWeight: '400',
    textTransform: 'capitalize',
  },

  // View all
  viewAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  viewAllText: {
    fontSize: 14,
    fontWeight: '600',
    color: ACCENT.blue,
  },

  // Bottom
  bottomSpacer: {
    height: 32,
  },

  // ─── STEP-3G: date pickers + briefing sections ───────────────────────────
  dateRangeRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginBottom: 20,
  },
  dateInputWrap: {
    flex: 1,
  },
  dateInputLabel: {
    fontSize: 11,
    fontWeight: '500',
    marginBottom: 4,
    letterSpacing: 0.2,
    textTransform: 'uppercase',
  },
  dateInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    fontWeight: '500',
  },
  dateResetButton: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateResetText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },

  sectionHeaderLink: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },

  sectionContainer: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: 20,
    marginTop: 0,
  },

  briefingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  briefingTextCol: {
    flex: 1,
    minWidth: 0,
  },
  briefingRightCol: {
    alignItems: 'flex-end',
    gap: 4,
  },
  briefingPrimary: {
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
    minWidth: 0,
  },
  briefingSecondary: {
    fontSize: 13,
    fontWeight: '400',
    marginLeft: 12,
  },
  briefingNumeric: {
    fontWeight: '700',
  },
  briefingMeta: {
    fontSize: 12,
    fontWeight: '400',
    marginTop: 2,
  },
  briefingAmount: {
    fontSize: 14,
    fontWeight: '700',
  },

  miniBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: 'flex-end',
  },
  miniBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  insightsList: {
    gap: 8,
    marginBottom: 20,
  },
  insightCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  insightIcon: {
    fontSize: 18,
    lineHeight: 22,
  },
  insightText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
  },
});
