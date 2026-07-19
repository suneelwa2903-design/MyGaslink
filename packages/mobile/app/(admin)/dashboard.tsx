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
  Modal,
  Alert,
  TextInput,
  FlatList,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useApiQuery } from '../../src/hooks/useApi';
import { useAuthStore } from '../../src/stores/authStore';
import { useTheme } from '../../src/theme';
import { DateInput, SelectField } from '../../src/components/ui';
import { api, getErrorMessage } from '../../src/lib/api';
// STAGE-A A6: PendingAction type import dropped — the PA section/query were
// both removed from the dashboard, so the type is no longer referenced.
import type { DashboardStats, OverdueCallListEntry } from '@gaslink/shared';
import { localDateISO } from '@gaslink/shared';

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
    href: '/customers',
  },
  {
    key: 'deliveredToday',
    label: 'Delivered',
    icon: 'checkmark-circle-outline',
    color: ACCENT.green,
    iconBgLight: '#ecfdf5',
    iconBgDark: 'rgba(16, 185, 129, 0.15)',
    href: '/orders',
  },
  {
    key: 'revenueToday',
    label: 'Revenue Today',
    icon: 'cash-outline',
    color: ACCENT.green,
    iconBgLight: '#ecfdf5',
    iconBgDark: 'rgba(16, 185, 129, 0.15)',
    isCurrency: true,
    href: '/reports',
  },
  {
    key: 'totalOutstanding',
    label: 'Outstanding',
    icon: 'wallet-outline',
    color: ACCENT.orange,
    iconBgLight: '#fffbeb',
    iconBgDark: 'rgba(245, 158, 11, 0.15)',
    isCurrency: true,
    href: '/collections',
  },
  {
    key: 'overdueInvoices',
    label: 'Overdue Invoices',
    icon: 'warning-outline',
    color: ACCENT.red,
    iconBgLight: '#fef2f2',
    iconBgDark: 'rgba(220, 38, 38, 0.15)',
    href: '/finance',
  },
  {
    key: 'inventoryAlerts',
    label: 'Inventory Alerts',
    icon: 'cube-outline',
    color: ACCENT.orange,
    iconBgLight: '#fffbeb',
    iconBgDark: 'rgba(245, 158, 11, 0.15)',
    href: '/inventory',
  },
];

// Mini-Operator (2026-07-17): reduced KPI grid — Customers, Delivered,
// Sales Today (Revenue relabeled), Overdue Bills (invoices relabeled).
// No Outstanding, no Inventory Alerts (per user feedback: reseller
// doesn't have vehicle-in-market outstanding, and stock alerts are
// noise for a small godown they can eyeball). Sales Today shows the
// cylinders delivered count as a subtitle so ₹ and qty read together.
const MINI_OP_KPI_KEYS: (keyof DashboardStats)[] = [
  'totalCustomers',
  'deliveredToday',
  'revenueToday',
  'overdueInvoices',
];
const MINI_OP_KPI_LABEL_OVERRIDES: Partial<Record<keyof DashboardStats, string>> = {
  deliveredToday: 'Delivered Today',
  revenueToday: 'Sales Today',
  overdueInvoices: 'Overdue Bills',
};

// ─── Component ───────────────────────────────────────────────────────────────

// ─── Date helpers (mirror STEP-3A pattern) ───────────────────────────────────

// Anti-pattern #21: localDateISO returns local-TZ YYYY-MM-DD instead of
// the UTC split that drifts by one day between 00:00–05:30 IST.
const toIsoDate = localDateISO;

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
  const isMiniOperator = user?.role === 'mini_operator_admin';

  // Mini-op-only: filter the KPI grid down to the 4 tiles the user asked
  // for. Also swap labels via MINI_OP_KPI_LABEL_OVERRIDES ("Sales Today"
  // etc.). Regular admin/finance keep the 6-card grid unchanged.
  const visibleKpiCards = isMiniOperator
    ? KPI_CARDS.filter((c) => MINI_OP_KPI_KEYS.includes(c.key)).map((c) => ({
        ...c,
        label: MINI_OP_KPI_LABEL_OVERRIDES[c.key] ?? c.label,
      }))
    : KPI_CARDS;

  // Mini-op Reports section state — Customer Ledger + Purchase Ledger
  // modal open flags. Both modals render inline (see bottom of file).
  const [customerLedgerOpen, setCustomerLedgerOpen] = useState(false);
  const [purchaseLedgerOpen, setPurchaseLedgerOpen] = useState(false);

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

        {/* KPI cards grid — 6 cards for regular admin, 4 for mini-op.
            Icon sits inline (left) with label + value stacked beside it.
            For mini-op Sales Today, the delivered-order count is rendered
            as a smaller subtitle so ₹ + qty read together. */}
        <View style={styles.kpiGrid}>
          {visibleKpiCards.map((card, index) => {
            const rawValue = stats?.[card.key] ?? 0;
            const displayValue = card.isCurrency
              ? formatCurrency(rawValue as number)
              : String(rawValue);
            const showQtySubtitle = isMiniOperator && card.key === 'revenueToday';
            const qtySubtitle = showQtySubtitle
              ? `${stats?.deliveredToday ?? 0} cyl. delivered`
              : null;

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
                    {qtySubtitle && (
                      <Text
                        style={{ fontSize: 11, color: theme.textMuted, marginTop: 1 }}
                        numberOfLines={1}
                      >
                        {qtySubtitle}
                      </Text>
                    )}
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Mini-Operator (2026-07-17): Reports section on the Home
            screen — two tiles, tapping either opens a filter modal that
            downloads the corresponding PDF from an existing backend
            endpoint. Customer Ledger uses GET /customers/:id/ledger/pdf;
            Purchase Ledger uses GET /purchase-entries/ledger.pdf. Both
            routes already allow mini_operator_admin (see prior 403 sweep
            + purchase ledger commit). Rendered ONLY for mini-op. */}
        {isMiniOperator && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Reports</Text>
            </View>
            <View style={styles.kpiGrid}>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => setCustomerLedgerOpen(true)}
                style={[styles.kpiCard, styles.kpiCardLeft]}
              >
                <View
                  style={[
                    styles.kpiCardInner,
                    { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, flexDirection: 'row', alignItems: 'center', gap: 12 },
                  ]}
                >
                  <View
                    style={[
                      styles.kpiIconContainer,
                      {
                        backgroundColor: isDark ? 'rgba(59, 130, 246, 0.15)' : '#eff6ff',
                        marginBottom: 0,
                      },
                    ]}
                  >
                    <Ionicons name="document-text-outline" size={22} color={ACCENT.blue} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.kpiLabel, { color: theme.textSecondary, marginBottom: 2 }]} numberOfLines={1}>
                      Customer Ledger
                    </Text>
                    <Text style={{ fontSize: 12, color: theme.textMuted }} numberOfLines={1}>
                      Pick customer + dates
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => setPurchaseLedgerOpen(true)}
                style={[styles.kpiCard, styles.kpiCardRight]}
              >
                <View
                  style={[
                    styles.kpiCardInner,
                    { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, flexDirection: 'row', alignItems: 'center', gap: 12 },
                  ]}
                >
                  <View
                    style={[
                      styles.kpiIconContainer,
                      {
                        backgroundColor: isDark ? 'rgba(139, 92, 246, 0.15)' : '#f5f3ff',
                        marginBottom: 0,
                      },
                    ]}
                  >
                    <Ionicons name="cart-outline" size={22} color={ACCENT.purple} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.kpiLabel, { color: theme.textSecondary, marginBottom: 2 }]} numberOfLines={1}>
                      Purchase Ledger
                    </Text>
                    <Text style={{ fontSize: 12, color: theme.textMuted }} numberOfLines={1}>
                      Source / cylinder filters
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* STAGE-A A6: Pending Actions section removed entirely from the
            dashboard per Suneel. The PA screen at /(admin)/pending-actions
            is still reachable from elsewhere in the app. */}
        {/* Mini-Operator (2026-07-17): hide the Stock Position / Call These
            Customers / Threshold Alerts briefing sections for
            mini_operator_admin — reseller asked for a cleaner Home. */}
        {/* ── STEP-3G: Stock Summary section (admin) ── */}
        {!isMiniOperator && stockSummary && stockSummary.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Stock Position</Text>
              <TouchableOpacity
                // Group-relative push: expo-router resolves to the current
                // tab group's `inventory` route. Lets this dashboard be
                // re-exported from (finance) without leaking into admin nav.
                onPress={() => router.push('/inventory')}
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
        {!isMiniOperator && callList && callList.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Call These Customers</Text>
              <TouchableOpacity
                // Group-relative push — see Stock Position note above.
                onPress={() => router.push('/collections')}
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
        {!isMiniOperator && thresholdAlerts && thresholdAlerts.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Threshold Alerts</Text>
              <TouchableOpacity
                // Group-relative push — see Stock Position note above.
                onPress={() => router.push('/inventory')}
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

      {/* Mini-Operator (2026-07-17): Reports modals rendered only for
          mini_operator_admin. Both defer to existing PDF endpoints
          (customer ledger, purchase ledger) which were opened for
          mini-op in prior commits. */}
      {isMiniOperator && (
        <>
          <CustomerLedgerModal
            visible={customerLedgerOpen}
            onClose={() => setCustomerLedgerOpen(false)}
          />
          <PurchaseLedgerModal
            visible={purchaseLedgerOpen}
            onClose={() => setPurchaseLedgerOpen(false)}
          />
        </>
      )}
    </SafeAreaView>
  );
}

// ─── Mini-Operator Reports modals ────────────────────────────────────────────

interface CustomerRow {
  customerId: string;
  customerName: string;
  businessName?: string | null;
  phone?: string | null;
}

interface SourceDistributorRow {
  id: string;
  name: string;
}

interface CylinderTypeRow {
  cylinderTypeId: string;
  typeName: string;
}

// Shared blob-fetch + share helper (mirrors the pattern in customer-detail.tsx
// and reports.tsx — expo-file-system write + Sharing.shareAsync).
async function downloadAndSharePdf(
  path: string,
  params: Record<string, string>,
  filename: string,
  dialogTitle: string,
): Promise<void> {
  const res = await api.get(path, { params, responseType: 'arraybuffer' });
  const bytes = new Uint8Array(res.data);
  const file = new File(Paths.cache, filename);
  try { file.create(); } catch { /* file already exists */ }
  file.write(bytes);
  if (!(await Sharing.isAvailableAsync())) {
    Alert.alert('Sharing unavailable', 'This device does not support sharing.');
    return;
  }
  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/pdf',
    dialogTitle,
    UTI: 'com.adobe.pdf',
  });
}

function CustomerLedgerModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { colors: theme } = useTheme();
  const [customerId, setCustomerId] = useState<string>('');
  const [customerName, setCustomerName] = useState<string>('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState<string>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return localDateISO(d);
  });
  const [to, setTo] = useState<string>(() => localDateISO(new Date()));
  const [downloading, setDownloading] = useState(false);

  const { data: customersResponse } = useApiQuery<{ customers: CustomerRow[] }>(
    ['dashboard-customers-list'],
    '/customers',
    { limit: 200 },
    { enabled: visible },
  );
  const allCustomers = customersResponse?.customers ?? [];
  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allCustomers;
    return allCustomers.filter((c) => {
      const name = (c.businessName || c.customerName || '').toLowerCase();
      const phone = (c.phone || '').toLowerCase();
      return name.includes(q) || phone.includes(q);
    });
  }, [allCustomers, search]);

  const handleDownload = async () => {
    if (!customerId) {
      Alert.alert('Pick a customer', 'Select a customer first.');
      return;
    }
    setDownloading(true);
    try {
      await downloadAndSharePdf(
        `/customers/${customerId}/ledger/pdf`,
        { from, to },
        `customer-ledger-${customerId}-${from}-${to}.pdf`,
        'Customer Ledger',
      );
      onClose();
    } catch (err) {
      Alert.alert('Could not download ledger', getErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {/* 2026-07-19 iPhone SafeArea fix — Modal on iOS spawns a fresh
          native view hierarchy that does NOT inherit the app-root
          SafeAreaProvider, so SafeAreaView reads 0 insets and the
          header overlaps the status bar / notch. Wrapping the Modal
          contents in a scoped SafeAreaProvider restores real insets
          so `edges={['top', ...]}` pushes the header below the notch. */}
      <SafeAreaProvider>
      <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: theme.bg }}>
        <View style={reportsStyles.header}>
          <Text style={[reportsStyles.headerTitle, { color: theme.text }]}>Customer Ledger</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={26} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>

        <View style={{ padding: 16, gap: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <DateInput label="From" value={from || null} onChange={setFrom} placeholder="From" />
            </View>
            <View style={{ flex: 1 }}>
              <DateInput label="To" value={to || null} onChange={setTo} placeholder="To" />
            </View>
          </View>

          <Text style={{ fontSize: 12, fontWeight: '600', color: theme.textSecondary, textTransform: 'uppercase', letterSpacing: 0.3 }}>
            Customer
          </Text>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search by name or phone"
            placeholderTextColor={theme.textMuted}
            style={{
              borderWidth: 1,
              borderColor: theme.cardBorder,
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 10,
              fontSize: 15,
              color: theme.text,
              backgroundColor: theme.cardBg,
            }}
          />
          {customerName ? (
            <View style={{ backgroundColor: theme.cardBg, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.cardBorder }}>
              <Text style={{ fontSize: 13, color: theme.textSecondary }}>Selected</Text>
              <Text style={{ fontSize: 15, fontWeight: '700', color: theme.text }}>{customerName}</Text>
            </View>
          ) : null}
        </View>

        <FlatList
          data={filteredCustomers}
          keyExtractor={(c) => c.customerId}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
          renderItem={({ item }) => {
            const selected = item.customerId === customerId;
            const display = item.businessName || item.customerName;
            return (
              <TouchableOpacity
                onPress={() => {
                  setCustomerId(item.customerId);
                  setCustomerName(display);
                }}
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 12,
                  borderRadius: 8,
                  backgroundColor: selected ? ACCENT.blue + '18' : 'transparent',
                  marginBottom: 4,
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: theme.text }}>{display}</Text>
                {item.phone ? (
                  <Text style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>{item.phone}</Text>
                ) : null}
              </TouchableOpacity>
            );
          }}
        />

        <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: theme.divider, flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity onPress={onClose} style={[reportsStyles.secondaryBtn, { borderColor: theme.cardBorder }]}>
            <Text style={{ color: theme.textSecondary, fontWeight: '600' }}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleDownload}
            disabled={downloading || !customerId}
            style={[reportsStyles.primaryBtn, { opacity: downloading || !customerId ? 0.5 : 1 }]}
          >
            {downloading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="download-outline" size={16} color="#fff" />
                <Text style={{ color: '#fff', fontWeight: '700' }}>Download PDF</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

function PurchaseLedgerModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { colors: theme } = useTheme();
  const [from, setFrom] = useState<string>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return localDateISO(d);
  });
  const [to, setTo] = useState<string>(() => localDateISO(new Date()));
  const [sourceDistributorId, setSourceDistributorId] = useState('');
  const [cylinderTypeId, setCylinderTypeId] = useState('');
  const [downloading, setDownloading] = useState(false);

  const { data: sources } = useApiQuery<SourceDistributorRow[]>(
    ['source-distributors'],
    '/source-distributors',
    undefined,
    { enabled: visible },
  );
  const { data: typesResp } = useApiQuery<{ cylinderTypes: CylinderTypeRow[] }>(
    ['cylinder-types'],
    '/cylinder-types',
    undefined,
    { enabled: visible },
  );
  const types = typesResp?.cylinderTypes ?? [];

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const params: Record<string, string> = { from, to };
      if (sourceDistributorId) params.sourceDistributorId = sourceDistributorId;
      if (cylinderTypeId) params.cylinderTypeId = cylinderTypeId;
      await downloadAndSharePdf(
        '/purchase-entries/ledger.pdf',
        params,
        `purchase-ledger-${from}-${to}.pdf`,
        'Purchase Ledger',
      );
      onClose();
    } catch (err) {
      Alert.alert('Could not download ledger', getErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {/* 2026-07-19 iPhone SafeArea fix — Modal on iOS spawns a fresh
          native view hierarchy that does NOT inherit the app-root
          SafeAreaProvider, so SafeAreaView reads 0 insets and the
          header overlaps the status bar / notch. Wrapping the Modal
          contents in a scoped SafeAreaProvider restores real insets
          so `edges={['top', ...]}` pushes the header below the notch. */}
      <SafeAreaProvider>
      <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: theme.bg }}>
        <View style={reportsStyles.header}>
          <Text style={[reportsStyles.headerTitle, { color: theme.text }]}>Purchase Ledger</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={26} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <DateInput label="From" value={from || null} onChange={setFrom} placeholder="From" />
            </View>
            <View style={{ flex: 1 }}>
              <DateInput label="To" value={to || null} onChange={setTo} placeholder="To" />
            </View>
          </View>

          <SelectField
            label="Source Distributor"
            value={sourceDistributorId}
            onChange={setSourceDistributorId}
            options={[
              { value: '', label: 'All source distributors' },
              ...(sources ?? []).map((s) => ({ value: s.id, label: s.name })),
            ]}
          />

          <SelectField
            label="Cylinder Type"
            value={cylinderTypeId}
            onChange={setCylinderTypeId}
            options={[
              { value: '', label: 'All cylinder types' },
              ...types.map((t) => ({ value: t.cylinderTypeId, label: t.typeName })),
            ]}
          />
        </ScrollView>

        <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: theme.divider, flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity onPress={onClose} style={[reportsStyles.secondaryBtn, { borderColor: theme.cardBorder }]}>
            <Text style={{ color: theme.textSecondary, fontWeight: '600' }}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleDownload}
            disabled={downloading}
            style={[reportsStyles.primaryBtn, { opacity: downloading ? 0.5 : 1 }]}
          >
            {downloading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="download-outline" size={16} color="#fff" />
                <Text style={{ color: '#fff', fontWeight: '700' }}>Download PDF</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const reportsStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  primaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#3b82f6',
    paddingVertical: 12,
    borderRadius: 10,
  },
  secondaryBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    paddingVertical: 12,
    borderRadius: 10,
  },
});

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
