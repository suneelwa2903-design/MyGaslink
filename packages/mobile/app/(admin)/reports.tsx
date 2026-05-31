import { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { api, getErrorMessage } from '../../src/lib/api';
import { useApiQuery } from '../../src/hooks/useApi';
import { useTheme, ACCENT as ACCENT_COLORS, formatINR } from '../../src/theme';
import { DateInput, EmptyState, SelectField } from '../../src/components/ui';

const ACCENT = ACCENT_COLORS.red;

// STAGE-H: mobile parity for web ReportsPage (packages/web/src/pages/ReportsPage.tsx).
// All 7 report types from packages/api/src/services/reportsService.ts:477-485 are
// implemented here against the single endpoint GET /api/reports/:reportType.
// CSV export uses ?format=csv and shares via expo-sharing (same pattern as the
// trip-sheet PDF in (admin)/orders.tsx:380-408). Customer-statement PDF goes
// through GET /customers/:id/ledger/pdf — the only PDF endpoint the API
// actually exposes (web ReportsPage:108 confirms it's customer-statement only).

// ─── Wire types — must match reportsService.ts ────────────────────────────────

type ReportCellValue = string | number | null;

interface ReportColumn {
  key: string;
  label: string;
  money?: boolean;
}

interface ReportTableData {
  title: string;
  columns: ReportColumn[];
  rows: Record<string, ReportCellValue>[];
  totals?: Record<string, ReportCellValue>;
}

interface ReportResult {
  columns: ReportColumn[];
  rows: Record<string, ReportCellValue>[];
  totals?: Record<string, ReportCellValue>;
  // Charts are returned by the server but rendering them as SVG on mobile
  // would add a chart lib + a lot of code for a screen most distributors will
  // use briefly. We surface a single-line summary instead.
  chart?: { type: 'line' | 'bar'; title: string; data: unknown };
  secondary?: ReportTableData;
}

type FilterKey = 'cylinderType' | 'driver' | 'customer' | 'vehicle' | 'groupBy';

interface ReportDef {
  key: string;
  label: string;
  filters: FilterKey[];
  customerRequired?: boolean;
}

// Mirrors REPORTS in web ReportsPage.tsx:19-27. Same labels, same filter
// dependencies, same `customerRequired` gate for customer-statement.
const REPORTS: ReportDef[] = [
  { key: 'sales-summary', label: 'Sales Summary', filters: ['cylinderType'] },
  { key: 'outstanding-aging', label: 'Outstanding & Aging', filters: [] },
  { key: 'gst-summary', label: 'GST Summary', filters: [] },
  { key: 'delivery-performance', label: 'Delivery Performance', filters: ['driver'] },
  { key: 'inventory-movement', label: 'Inventory Movement', filters: ['cylinderType'] },
  {
    key: 'customer-statement',
    label: 'Customer Statement',
    filters: ['customer'],
    customerRequired: true,
  },
  {
    key: 'vehicle-ledger',
    label: 'Vehicle Ledger',
    filters: ['vehicle', 'driver', 'cylinderType', 'groupBy'],
  },
];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function monthAgoISO(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
}

function fmtCell(value: ReportCellValue, money?: boolean): string {
  if (value == null || value === '') return money ? '' : '—';
  if (money) {
    const n = Number(value);
    return Number.isFinite(n) ? formatINR(n) : String(value);
  }
  return String(value);
}

export default function AdminReportsScreen() {
  const { colors } = useTheme();

  const [reportKey, setReportKey] = useState('sales-summary');
  const [dateFrom, setDateFrom] = useState(monthAgoISO());
  const [dateTo, setDateTo] = useState(todayISO());
  const [cylinderTypeId, setCylinderTypeId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [groupBy, setGroupBy] = useState<'day' | 'trip'>('day');
  const [downloading, setDownloading] = useState(false);

  const def = REPORTS.find((r) => r.key === reportKey)!;
  const needsCustomer = !!def.customerRequired && !customerId;

  // ─── Filter option data ─────────────────────────────────────────────────
  const { data: customersResp } = useApiQuery<{
    customers: { customerId: string; customerName: string }[];
  }>(['report-customers'], '/customers', { pageSize: 100 });
  const customers = customersResp?.customers ?? [];

  const { data: cylinderTypesResp } = useApiQuery<{
    cylinderTypes: { cylinderTypeId: string; typeName: string }[];
  }>(['report-cyl'], '/cylinder-types');
  const cylinderTypes = cylinderTypesResp?.cylinderTypes ?? [];

  const { data: driversResp } = useApiQuery<{
    drivers: { driverId: string; driverName: string }[];
  }>(['report-drivers'], '/drivers');
  const drivers = driversResp?.drivers ?? [];

  const { data: vehiclesResp } = useApiQuery<{
    vehicles: { vehicleId: string; vehicleNumber: string | null }[];
  }>(['report-vehicles'], '/vehicles');
  const vehicles = vehiclesResp?.vehicles ?? [];

  // ─── Build params ───────────────────────────────────────────────────────
  const params = useMemo(() => {
    const p: Record<string, unknown> = { dateFrom, dateTo };
    if (def.filters.includes('cylinderType') && cylinderTypeId) p.cylinderTypeId = cylinderTypeId;
    if (def.filters.includes('driver') && driverId) p.driverId = driverId;
    if (def.filters.includes('customer') && customerId) p.customerId = customerId;
    if (def.filters.includes('vehicle') && vehicleId) p.vehicleId = vehicleId;
    if (def.filters.includes('groupBy')) p.groupBy = groupBy;
    return p;
  }, [dateFrom, dateTo, cylinderTypeId, driverId, customerId, vehicleId, groupBy, def]);

  const {
    data: report,
    isLoading,
    isError,
    error,
    refetch,
  } = useApiQuery<ReportResult>(
    ['report', reportKey, JSON.stringify(params)],
    `/reports/${reportKey}`,
    params,
    { enabled: !needsCustomer },
  );

  // ─── Downloads ──────────────────────────────────────────────────────────
  // Anti-pattern #5 fix: route through the shared axios client (which injects
  // Authorization + X-Distributor-Id). The web bypassed this with raw URL.
  async function downloadAndShare(
    url: string,
    extraParams: Record<string, unknown>,
    filename: string,
    mimeType: string,
    uti: string,
    dialogTitle: string,
  ) {
    setDownloading(true);
    try {
      const res = await api.get(url, { params: extraParams, responseType: 'arraybuffer' });
      const bytes = new Uint8Array(res.data as ArrayBuffer);
      const file = new File(Paths.cache, filename);
      try {
        file.create();
      } catch {
        /* already exists — overwrite below */
      }
      file.write(bytes);

      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device does not support sharing.');
        return;
      }
      await Sharing.shareAsync(file.uri, { mimeType, dialogTitle, UTI: uti });
    } catch (err) {
      Alert.alert('Download failed', getErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  }

  const downloadCsv = () =>
    downloadAndShare(
      `/reports/${reportKey}`,
      { ...params, format: 'csv' },
      `${reportKey}-${dateFrom}_${dateTo}-${Date.now()}.csv`,
      'text/csv',
      'public.comma-separated-values-text',
      'Report CSV',
    );

  const downloadPdf = () => {
    // Only customer-statement has a PDF endpoint (web ReportsPage.tsx:108).
    if (!customerId) return;
    return downloadAndShare(
      `/customers/${customerId}/ledger/pdf`,
      { from: dateFrom, to: dateTo },
      `statement-${dateFrom}_${dateTo}-${Date.now()}.pdf`,
      'application/pdf',
      'com.adobe.pdf',
      'Customer Statement',
    );
  };

  // ─── Report-type picker shows every report. Per-report filter rows below
  // appear conditionally based on `def.filters`.
  const reportOptions = REPORTS.map((r) => ({ value: r.key, label: r.label }));
  const customerOptions = [
    { value: '', label: 'Select customer' },
    ...customers.map((c) => ({ value: c.customerId, label: c.customerName })),
  ];
  const cylinderOptions = [
    { value: '', label: 'All types' },
    ...cylinderTypes.map((c) => ({ value: c.cylinderTypeId, label: c.typeName })),
  ];
  const driverOptions = [
    { value: '', label: 'All drivers' },
    ...drivers.map((d) => ({ value: d.driverId, label: d.driverName })),
  ];
  const vehicleOptions = [
    { value: '', label: 'All vehicles' },
    ...vehicles
      .filter((v) => v.vehicleNumber)
      .map((v) => ({ value: v.vehicleId, label: v.vehicleNumber as string })),
  ];
  const groupByOptions = [
    { value: 'day', label: 'Day' },
    { value: 'trip', label: 'Trip' },
  ];

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => {
              if (!needsCustomer) refetch();
            }}
            tintColor={ACCENT}
          />
        }
      >
        {/* Report selector */}
        <SelectField
          label="Report"
          value={reportKey}
          options={reportOptions}
          onChange={setReportKey}
          accent={ACCENT}
        />

        {/* Date range */}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 4 }}>
              From
            </Text>
            <DateInput value={dateFrom || null} onChange={setDateFrom} placeholder="From" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 4 }}>To</Text>
            <DateInput value={dateTo || null} onChange={setDateTo} placeholder="To" />
          </View>
        </View>

        {/* Per-report filters */}
        {def.filters.includes('customer') && (
          <SelectField
            label={`Customer${def.customerRequired ? ' *' : ''}`}
            value={customerId}
            options={customerOptions}
            onChange={setCustomerId}
            accent={ACCENT}
          />
        )}
        {def.filters.includes('cylinderType') && (
          <SelectField
            label="Cylinder Type"
            value={cylinderTypeId}
            options={cylinderOptions}
            onChange={setCylinderTypeId}
            accent={ACCENT}
          />
        )}
        {def.filters.includes('driver') && (
          <SelectField
            label="Driver"
            value={driverId}
            options={driverOptions}
            onChange={setDriverId}
            accent={ACCENT}
          />
        )}
        {def.filters.includes('vehicle') && (
          <SelectField
            label="Vehicle"
            value={vehicleId}
            options={vehicleOptions}
            onChange={setVehicleId}
            accent={ACCENT}
          />
        )}
        {def.filters.includes('groupBy') && (
          <SelectField
            label="Group By"
            value={groupBy}
            options={groupByOptions}
            onChange={(v) => setGroupBy(v as 'day' | 'trip')}
            accent={ACCENT}
          />
        )}

        {/* Download buttons */}
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
          <TouchableOpacity
            onPress={downloadCsv}
            disabled={downloading || needsCustomer || !report}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              paddingVertical: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: colors.cardBorder,
              backgroundColor: colors.cardBg,
              opacity: downloading || needsCustomer || !report ? 0.5 : 1,
            }}
          >
            {downloading ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <Ionicons name="download-outline" size={16} color={colors.text} />
            )}
            <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>CSV</Text>
          </TouchableOpacity>
          {reportKey === 'customer-statement' && (
            <TouchableOpacity
              onPress={downloadPdf}
              disabled={downloading || !customerId}
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                paddingVertical: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.cardBorder,
                backgroundColor: colors.cardBg,
                opacity: downloading || !customerId ? 0.5 : 1,
              }}
            >
              <Ionicons name="document-text-outline" size={16} color={colors.text} />
              <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>PDF</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Chart summary banner — we don't render the SVG; instead show the
            title + point count so the user knows the underlying data is there. */}
        {report?.chart && (
          <View
            style={{
              padding: 12,
              borderRadius: 10,
              backgroundColor: colors.cardBg,
              borderWidth: 1,
              borderColor: colors.cardBorder,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Ionicons
              name={report.chart.type === 'line' ? 'trending-up' : 'bar-chart'}
              size={18}
              color={ACCENT}
            />
            <Text style={{ fontSize: 13, color: colors.textSecondary, flex: 1 }}>
              {report.chart.title}
            </Text>
            <Text style={{ fontSize: 11, color: colors.textMuted }}>see CSV for raw values</Text>
          </View>
        )}

        {/* Body */}
        {needsCustomer ? (
          <EmptyState
            title="Select a customer"
            description="The Customer Statement report requires a customer."
          />
        ) : isLoading ? (
          <View style={{ paddingVertical: 48, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : isError ? (
          <EmptyState title="Could not load report" description={getErrorMessage(error)} />
        ) : !report || (report.rows.length === 0 && !report.secondary?.rows?.length) ? (
          <EmptyState title="No data" description="No records match the selected filters." />
        ) : (
          <>
            {report.secondary && report.secondary.rows.length > 0 && (
              <ReportTable
                title={report.secondary.title}
                columns={report.secondary.columns}
                rows={report.secondary.rows}
                totals={report.secondary.totals}
              />
            )}
            {report.rows.length > 0 && (
              <ReportTable
                columns={report.columns}
                rows={report.rows}
                totals={report.totals}
              />
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Table renderer ────────────────────────────────────────────────────────
// Horizontal scroll for wide tables (GST Summary has 8 columns, Vehicle
// Ledger has 11). Each column gets a minimum width so labels don't crush.
function ReportTable({
  title,
  columns,
  rows,
  totals,
}: {
  title?: string;
  columns: ReportColumn[];
  rows: Record<string, ReportCellValue>[];
  totals?: Record<string, ReportCellValue>;
}) {
  const { colors } = useTheme();

  const colWidth = (c: ReportColumn): number => {
    // Money columns get a touch more room for ₹ + thousands separators.
    if (c.money) return 130;
    if (c.label.length > 16) return 160;
    return 120;
  };

  return (
    <View
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.cardBorder,
        backgroundColor: colors.cardBg,
        overflow: 'hidden',
      }}
    >
      {title && (
        <Text
          style={{
            fontSize: 14,
            fontWeight: '700',
            color: colors.text,
            paddingHorizontal: 12,
            paddingTop: 12,
            paddingBottom: 8,
          }}
        >
          {title}
        </Text>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              borderBottomWidth: 1,
              borderBottomColor: colors.divider,
              backgroundColor: colors.inputBg,
            }}
          >
            {columns.map((c) => (
              <Text
                key={c.key}
                style={{
                  width: colWidth(c),
                  paddingHorizontal: 10,
                  paddingVertical: 10,
                  fontSize: 11,
                  fontWeight: '700',
                  color: colors.textSecondary,
                  textTransform: 'uppercase',
                  textAlign: c.money ? 'right' : 'left',
                }}
              >
                {c.label}
              </Text>
            ))}
          </View>
          {/* Rows */}
          {rows.map((row, i) => (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                borderBottomWidth: 1,
                borderBottomColor: colors.divider,
              }}
            >
              {columns.map((c) => (
                <Text
                  key={c.key}
                  style={{
                    width: colWidth(c),
                    paddingHorizontal: 10,
                    paddingVertical: 9,
                    fontSize: 12,
                    color: colors.text,
                    textAlign: c.money ? 'right' : 'left',
                  }}
                  numberOfLines={2}
                >
                  {fmtCell(row[c.key], c.money)}
                </Text>
              ))}
            </View>
          ))}
          {/* Totals */}
          {totals && (
            <View
              style={{
                flexDirection: 'row',
                borderTopWidth: 2,
                borderTopColor: colors.cardBorder,
                backgroundColor: colors.inputBg,
              }}
            >
              {columns.map((c) => (
                <Text
                  key={c.key}
                  style={{
                    width: colWidth(c),
                    paddingHorizontal: 10,
                    paddingVertical: 10,
                    fontSize: 12,
                    fontWeight: '800',
                    color: colors.text,
                    textAlign: c.money ? 'right' : 'left',
                  }}
                  numberOfLines={2}
                >
                  {fmtCell(totals[c.key], c.money)}
                </Text>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
