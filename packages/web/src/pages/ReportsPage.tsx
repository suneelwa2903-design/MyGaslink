import { useMemo, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { HiOutlineArrowDownTray, HiOutlineChevronDown, HiOutlineChevronRight, HiOutlineDocumentArrowDown, HiOutlineUserGroup, HiOutlinePlus } from 'react-icons/hi2';
import { localTodayISO, localDateISO, formatDisplayDate, reportFilterSpec, type ReportFilterKey, type ReportCatalogEntry, type ReportBucketDef, type SavedReportDto } from '@gaslink/shared';
import { api, apiGet, getErrorMessage } from '@/lib/api';
import { Button, Select, Loader, EmptyState, Modal } from '@/components/ui';
import { CustomerSearchInput } from '@/components/ui/CustomerSearchInput';
import TallyExportPanel from '@/components/reports/TallyExportPanel';
import GstFilingExportPanel from '@/components/reports/GstFilingExportPanel';
import { useAuthStore, selectRole } from '@/stores/authStore';
import {
  listFilterPresets, saveFilterPreset, deleteFilterPreset, type FilterPreset,
  getHiddenColumns, setHiddenColumns,
  getStickyDates, setStickyDates, clearStickyDates,
} from '@/lib/reportPreferences';
// Recent Reports section was removed 2026-08-06 — the Recent list duplicated
// entries the user could reach via the accordion (their bucket auto-expanded
// on click), which read as two highlighted rows for one selection. The
// getRecentReports / pushRecentReport helpers are kept in reportPreferences.ts
// for a future revival if the sidebar acquires enough entries to warrant it.

interface ReportCatalogResponse {
  buckets: ReportBucketDef[];
  entries: ReportCatalogEntry[];
}

type ReportCellValue = string | number | null;
type LineChartData = { x: string; y: number }[];
type BarChartData = { labels: string[]; series: { name: string; values: number[] }[] };
interface ReportColumn { key: string; label: string; money?: boolean; date?: boolean }
interface ReportChart { type: 'line' | 'bar'; title: string; data: LineChartData | BarChartData }
interface ReportTableData { title: string; columns: ReportColumn[]; rows: Record<string, ReportCellValue>[]; totals?: Record<string, ReportCellValue> }
interface ReportResult { columns: ReportColumn[]; rows: Record<string, ReportCellValue>[]; totals?: Record<string, ReportCellValue>; chart?: ReportChart; secondary?: ReportTableData }

type FilterKey = ReportFilterKey;
interface ReportDef { key: string; label: string; filters: FilterKey[]; customerRequired?: boolean }

// Labels + ordering live here; each report's FILTERS come from the shared
// REPORT_FILTER_SPECS (packages/shared/src/constants/reportFilters.ts) so the
// web and mobile Reports screens can never drift on which filters a report
// exposes. Adding a report = add a label here + an entry in the shared spec
// (a guard test enforces every catalog report has a spec).
const REPORT_LABELS: Array<{ key: string; label: string }> = [
  { key: 'sales-summary', label: 'Sales Summary' },
  { key: 'outstanding-aging', label: 'Outstanding & Aging' },
  { key: 'gst-summary', label: 'GST Summary' },
  { key: 'delivery-performance', label: 'Delivery Performance' },
  { key: 'inventory-movement', label: 'Inventory Movement' },
  { key: 'customer-statement', label: 'Customer Statement' },
  { key: 'vehicle-ledger', label: 'Vehicle Ledger' },
  { key: 'payment-collections', label: 'Payment Collections' },
  { key: 'day-close-summary', label: 'Day-Close Summary' },
  { key: 'daily-sales', label: 'Daily Sales' },
  { key: 'driver-daily-log', label: 'Driver Daily Log' },
  { key: 'deposit-ledger-by-customer', label: 'Deposit Ledger per Customer' },
  { key: 'stock-adjustment-audit-log', label: 'Stock Adjustment Audit Log' },
  { key: 'expense-register', label: 'Expense Register' },
  { key: 'credit-notes-register', label: 'Credit Notes Register' },
  { key: 'debit-notes-register', label: 'Debit Notes Register' },
  { key: 'opening-balance-certificates-register', label: 'Opening Balance Certificates' },
  { key: 'cylinder-rotation', label: 'Cylinder Rotation' },
  { key: 'driver-vehicle-cost-breakdown', label: 'Driver & Vehicle Cost Breakdown' },
  { key: 'empties-in-transit', label: 'Empties in Transit' },
  { key: 'payment-method-mix', label: 'Payment Method Mix' },
  { key: 'rate-variance-leakage', label: 'Rate Variance / Discount Leakage' },
  { key: 'cash-book', label: 'Cash Book' },
  { key: 'cashflow-statement', label: 'Cashflow Statement' },
  { key: 'expenses-by-category-trend', label: 'Expenses by Category (Trend)' },
  { key: 'accountability-log-report', label: 'Accountability Log' },
  { key: 'gst-reconciliation', label: 'GST Reconciliation' },
  { key: 'gstr-3b-preview', label: 'GSTR-3B Preview' },
  { key: 'customer-profitability', label: 'Customer Profitability' },
  { key: 'corp-landed-cost-trend', label: 'Landed Cost Trend' },
  { key: 'corp-statement-register', label: 'Corporation Statement Register' },
  { key: 'corp-purchase-vs-sale-margin', label: 'Purchase vs Sale Margin' },
  { key: 'corp-batch-cost-vs-price', label: 'Batch Cost vs Price (FIFO)' },
  { key: 'corp-supplier-payment-aging', label: 'Supplier Payment Aging' },
  { key: 'corp-landed-cost-reconciliation', label: 'Landed Cost Reconciliation' },
];
const REPORTS: ReportDef[] = REPORT_LABELS.map((r) => ({
  key: r.key,
  label: r.label,
  ...reportFilterSpec(r.key),
}));

// 2026-08-06: null / undefined / empty-string money renders as em-dash so
// count-only rows (e.g. Day-Close DELIVERIES section — amount is
// intentionally null, we already showed the ₹ in the REVENUE section) don't
// look like "actually ₹0".
const fmtMoney = (v: ReportCellValue | undefined) => {
  if (v == null || v === '') return '—';
  return `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
};
// DATE-FIX (2026-08-08): a bare ISO date value (YYYY-MM-DD, the shape every
// report emits for date columns) renders as dd/MM/yyyy. Month buckets
// (YYYY-MM) and everything else pass through untouched.
const isIsoDate = (v: ReportCellValue | undefined): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const fmtCell = (v: ReportCellValue | undefined, col: ReportColumn): string => {
  if (col.money) return fmtMoney(v);
  if (col.date || isIsoDate(v)) return formatDisplayDate(v as string);
  return String(v ?? '');
};
const isOverdueRow = (r: Record<string, ReportCellValue>) => Number(r.b31_60 || 0) > 0 || Number(r.b60plus || 0) > 0;

function todayStr() { return localTodayISO(); }
function monthAgoStr() { const d = new Date(); d.setMonth(d.getMonth() - 1); return localDateISO(d); }
// INVESTIGATION-JUL09: delivery-performance defaults to yesterday..today so
// the operator lands on "yesterday's numbers" — the most-asked view.
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate() - 1); return localDateISO(d); }

export default function ReportsPage({ initialReport }: { initialReport?: string } = {}) {
  const [reportKey, setReportKey] = useState(initialReport || 'sales-summary');
  const [dateFrom, setDateFrom] = useState(monthAgoStr());
  const [dateTo, setDateTo] = useState(todayStr());
  const [cylinderTypeId, setCylinderTypeId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [groupBy, setGroupBy] = useState<'day' | 'trip'>('day');
  // 2026-07-17: Payment Collections entry-date filter — narrows by
  // PaymentTransaction.createdAt (data-entry timestamp). Both blank by
  // default so the initial Payment Collections view keeps historical
  // behavior (Payment Date range only).
  const [entryDateFrom, setEntryDateFrom] = useState('');
  const [entryDateTo, setEntryDateTo] = useState('');
  // 2026-08-06 N18 Customer Profitability — AR interest rate editable
  // per-run per Suneel's "rate differs from time to time" spec. Persisted
  // per-user via reportPreferences (see loader effect below). Default 12%.
  const [arInterestRatePct, setArInterestRatePct] = useState<string>('12');
  // 2026-08-05 F3 — WI-5 Vehicle Ledger View dropdown removed. Corporation
  // Loads no longer surface here at all (they live on Inventory → Depot
  // History exclusively). Backend `vehicleLedger()` no longer emits
  // `secondary`, so client-side filter state is gone too.
  const [downloading, setDownloading] = useState(false);
  // INVESTIGATION-JUL09 — Delivery Performance drill-down state.
  // Which driver's customer breakdown is open in the modal, if any.
  const [drillDownDriverId, setDrillDownDriverId] = useState<string | null>(null);
  const [drillDownDriverName, setDrillDownDriverName] = useState<string>('');
  // Which top-level driver_summary rows are expanded to show cylinder_row children.
  const [expandedDrivers, setExpandedDrivers] = useState<Set<string>>(new Set());

  // ─── Phase 1 templates polish (2026-08-05) ─────────────────────────
  const userId = useAuthStore((s) => s.user?.userId ?? null);
  const [presets, setPresets] = useState<FilterPreset[]>([]);
  const [activePresetId, setActivePresetId] = useState<string>('');
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [columnsModalOpen, setColumnsModalOpen] = useState(false);
  const [hiddenColumns, setHiddenColumnsState] = useState<Set<string>>(new Set());

  /* eslint-disable react-hooks/set-state-in-effect --
   * Effects below restore persisted UI state from localStorage
   * (sticky-dates, per-report presets + hidden columns). Deriving these
   * during render isn't possible because localStorage reads block SSR-
   * initialised useState; the one-shot init-on-user-change pattern is
   * intentional. Cascading-render concern is bounded — each effect
   * fires only when its dep tuple changes.
   */
  useEffect(() => {
    if (!userId) return;
    const sticky = getStickyDates(userId);
    if (sticky?.dateFrom && sticky?.dateTo) {
      setDateFrom(sticky.dateFrom);
      setDateTo(sticky.dateTo);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    setStickyDates(userId, { dateFrom, dateTo });
  }, [userId, dateFrom, dateTo]);

  useEffect(() => {
    if (!userId) return;
    setPresets(listFilterPresets(userId, reportKey));
    setHiddenColumnsState(getHiddenColumns(userId, reportKey));
    setActivePresetId('');
  }, [userId, reportKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 2026-08-05 F2 — `def` can be undefined when the sidebar selects a
  // download-kind entry (e.g. tally-export, gst-filing-export) that
  // isn't in the local inline-only REPORTS array. Every consumer below
  // must guard for null.
  const def = REPORTS.find((r) => r.key === reportKey) ?? null;

  // INVESTIGATION-JUL09 — when the user switches TO delivery-performance for
  // the first time in this session, reset dates to yesterday..today. This
  // matches the "landing on yesterday's numbers" default the ops team asks
  // for. Wrapped in a helper so REPORTS button clicks are intent-preserving.
  function pickReport(key: string) {
    if (key === 'delivery-performance' && reportKey !== 'delivery-performance') {
      setDateFrom(yesterdayStr());
      setDateTo(todayStr());
    }
    setReportKey(key);
    setExpandedDrivers(new Set());
  }

  // ─── Phase 1 handlers ─────────────────────────────────────────────

  const applyPreset = (presetId: string) => {
    setActivePresetId(presetId);
    if (!presetId) return;
    const p = presets.find((x) => x.id === presetId);
    if (!p) return;
    // Restore each filter the preset saved. Preset only stores fields that
    // were non-empty at save time — missing keys leave current state alone.
    if (p.filters.customerId !== undefined) setCustomerId(p.filters.customerId);
    if (p.filters.driverId !== undefined) setDriverId(p.filters.driverId);
    if (p.filters.vehicleId !== undefined) setVehicleId(p.filters.vehicleId);
    if (p.filters.cylinderTypeId !== undefined) setCylinderTypeId(p.filters.cylinderTypeId);
    if (p.filters.groupBy !== undefined) setGroupBy(p.filters.groupBy as 'day' | 'trip');
    if (p.filters.entryDateFrom !== undefined) setEntryDateFrom(p.filters.entryDateFrom);
    if (p.filters.entryDateTo !== undefined) setEntryDateTo(p.filters.entryDateTo);
    if (p.filters.arInterestRatePct !== undefined) setArInterestRatePct(p.filters.arInterestRatePct);
    if (p.dateFrom) setDateFrom(p.dateFrom);
    if (p.dateTo) setDateTo(p.dateTo);
  };

  const saveCurrentAsPreset = () => {
    if (!userId || !newPresetName.trim()) return;
    const filters: Record<string, string> = {};
    if (customerId) filters.customerId = customerId;
    if (driverId) filters.driverId = driverId;
    if (vehicleId) filters.vehicleId = vehicleId;
    if (cylinderTypeId) filters.cylinderTypeId = cylinderTypeId;
    filters.groupBy = groupBy;
    if (entryDateFrom) filters.entryDateFrom = entryDateFrom;
    if (entryDateTo) filters.entryDateTo = entryDateTo;
    if (arInterestRatePct) filters.arInterestRatePct = arInterestRatePct;
    const created = saveFilterPreset(userId, reportKey, {
      name: newPresetName.trim(),
      filters,
      dateFrom,
      dateTo,
    });
    setPresets(listFilterPresets(userId, reportKey));
    setActivePresetId(created.id);
    setSavePresetOpen(false);
    setNewPresetName('');
    toast.success(`Preset "${created.name}" saved`);
  };

  const removeActivePreset = () => {
    if (!userId || !activePresetId) return;
    const p = presets.find((x) => x.id === activePresetId);
    deleteFilterPreset(userId, reportKey, activePresetId);
    setPresets(listFilterPresets(userId, reportKey));
    setActivePresetId('');
    if (p) toast.success(`Preset "${p.name}" removed`);
  };

  const toggleColumnVisibility = (colKey: string) => {
    const next = new Set(hiddenColumns);
    if (next.has(colKey)) next.delete(colKey);
    else next.add(colKey);
    setHiddenColumnsState(next);
    if (userId) setHiddenColumns(userId, reportKey, next);
  };

  const resetHiddenColumns = () => {
    setHiddenColumnsState(new Set());
    if (userId) setHiddenColumns(userId, reportKey, new Set());
  };

  const resetDatesToDefault = () => {
    // Default is yesterday..today for delivery-performance, else month-ago..today.
    if (reportKey === 'delivery-performance') {
      setDateFrom(yesterdayStr()); setDateTo(todayStr());
    } else {
      setDateFrom(monthAgoStr()); setDateTo(todayStr());
    }
    if (userId) clearStickyDates(userId);
  };

  // Filter option data (lazy/shared)
  // Customers use the server-side search autocomplete (CustomerSearchInput)
  // so we no longer pre-fetch a capped list — an artificial `pageSize: 100`
  // limit silently hid customers past #100 on the Customer Statement picker.
  // 2026-08-05 F2 — Fetch the report catalog (7 buckets + N entries,
  // pre-filtered by caller's role). Drives the left-nav sidebar. Cached
  // for the session — buckets + entries are effectively static within a
  // session (they change only on server restart when a new N-series
  // report is added).
  const { data: catalog } = useQuery({
    queryKey: ['reports-catalog'],
    queryFn: () => apiGet<ReportCatalogResponse>('/reports/catalog'),
    staleTime: 60 * 60 * 1000, // 1 hour
  });

  // Phase 2 — user's saved custom reports (their own + tenant-shared).
  const { data: savedReportsResp } = useQuery({
    queryKey: ['saved-reports-list'],
    queryFn: () => apiGet<{ savedReports: SavedReportDto[] }>('/saved-reports'),
    staleTime: 5 * 60 * 1000, // 5 min — invalidated on save/delete in the builder
  });
  const savedReports = savedReportsResp?.savedReports ?? [];
  const navigate = useNavigate();

  const { data: cylinderTypes } = useQuery({
    queryKey: ['report-cyl'],
    queryFn: () => apiGet<{ cylinderTypes: { cylinderTypeId: string; typeName: string }[] }>('/cylinder-types'),
    select: (d) => d.cylinderTypes,
  });
  const { data: drivers } = useQuery({
    queryKey: ['report-drivers'],
    queryFn: () => apiGet<{ drivers: { driverId: string; driverName: string }[] }>('/drivers'),
    select: (d) => d.drivers,
  });
  const { data: vehicles } = useQuery({
    queryKey: ['report-vehicles'],
    queryFn: () => apiGet<{ vehicles: { vehicleId: string; vehicleNumber: string | null }[] }>('/vehicles'),
    select: (d) => d.vehicles,
  });

  const params = useMemo(() => {
    const p: Record<string, unknown> = { dateFrom, dateTo };
    if (!def) return p;
    if (def.filters.includes('cylinderType') && cylinderTypeId) p.cylinderTypeId = cylinderTypeId;
    if (def.filters.includes('driver') && driverId) p.driverId = driverId;
    if (def.filters.includes('customer') && customerId) p.customerId = customerId;
    if (def.filters.includes('vehicle') && vehicleId) p.vehicleId = vehicleId;
    if (def.filters.includes('groupBy')) p.groupBy = groupBy;
    if (def.filters.includes('entryDate')) {
      if (entryDateFrom) p.entryDateFrom = entryDateFrom;
      if (entryDateTo) p.entryDateTo = entryDateTo;
    }
    if (def.filters.includes('arInterestRate')) {
      // Backend clamps to [0, 50]; UI just passes the string number through.
      // Empty string / NaN falls back to server default (12%).
      const n = Number(arInterestRatePct);
      if (Number.isFinite(n) && n >= 0) p.arInterestRatePct = n;
    }
    return p;
  }, [dateFrom, dateTo, cylinderTypeId, driverId, customerId, vehicleId, groupBy, entryDateFrom, entryDateTo, arInterestRatePct, def]);

  const needsCustomer = !!def?.customerRequired && !customerId;

  const { data: report, isLoading, isError, error } = useQuery({
    queryKey: ['report', reportKey, params],
    queryFn: () => apiGet<ReportResult>(`/reports/${reportKey}`, params),
    // Only fire the inline-report query when `def` is loaded (i.e. current
    // selection is an inline-kind entry). Download-kind selections
    // (tally, gst-filing, driver-statement) render their own panels
    // without hitting /api/reports/:slug.
    enabled: !!def && !needsCustomer,
  });

  async function downloadBlob(url: string, extraParams: Record<string, unknown>, filename: string) {
    setDownloading(true);
    try {
      const res = await api.get(url, { params: extraParams, responseType: 'blob' });
      const href = window.URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = href; a.download = filename; a.click();
      window.URL.revokeObjectURL(href);
      toast.success('Download started');
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally { setDownloading(false); }
  }

  const downloadCsv = () => downloadBlob(
    `/reports/${reportKey}`,
    {
      ...params,
      format: 'csv',
      // Delivery Performance CSV export includes per-customer breakdown
      // rows under each driver's cylinder rows for a full audit-trail
      // export. The on-screen table stays clean via the row-type filter.
      ...(reportKey === 'delivery-performance' ? { includeCustomers: 'true' } : {}),
    },
    `${reportKey}-${dateFrom}_${dateTo}.csv`,
  );
  const downloadPdf = () => customerId && downloadBlob(`/customers/${customerId}/ledger/pdf`, { from: dateFrom, to: dateTo }, `statement-${dateFrom}_${dateTo}.pdf`);

  // Mini-Operator (2026-07-16): hide the Tally Export section — mini-op
  // uses their own bookkeeping and doesn't sync to Tally. The rest of the
  // Reports page (Sales Summary, Outstanding, Inventory Movement, etc.)
  // stays visible.
  const role = useAuthStore(selectRole);
  const isMiniOperator = role === 'mini_operator_admin';

  // 2026-08-05 F2 — Look up the currently-selected catalog entry. Drives
  // which content pane renders in the main area (inline report vs
  // download panel vs external hint). Falls back to null while catalog
  // is loading — the sidebar shows a loader in that window.
  const selectedEntry = useMemo<ReportCatalogEntry | null>(() => {
    if (!catalog) return null;
    return catalog.entries.find((e) => e.slug === reportKey) ?? null;
  }, [catalog, reportKey]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
      {/* ── Left nav: buckets + entries ───────────────────────────────── */}
      <aside>
        <ReportsSidebar
          catalog={catalog}
          selectedSlug={reportKey}
          onSelect={(slug) => pickReport(slug)}
          isMiniOperator={isMiniOperator}
          savedReports={savedReports}
          onOpenSaved={(sid) => navigate(`/app/report-builder/${sid}`)}
          onNewCustomReport={() => navigate('/app/report-builder')}
        />
      </aside>

      {/* ── Main content: filters + report body OR download panel ─────── */}
      <div className="space-y-6 min-w-0">
        {/* Download-kind entries: render dedicated panels instead of the
            filter row + table body. Tally + GST have their own bespoke
            panels; new download entries share a generic date-range download. */}
        {selectedEntry?.kind === 'download' && selectedEntry.slug === 'tally-export' && (
          !isMiniOperator ? <TallyExportPanel dateFrom={dateFrom} dateTo={dateTo} /> : (
            <EmptyState title="Not available" description="Tally export is not available for mini-operator accounts." />
          )
        )}
        {selectedEntry?.kind === 'download' && selectedEntry.slug === 'gst-filing-export' && (
          !isMiniOperator ? <GstFilingExportPanel /> : (
            <EmptyState title="Not available" description="GST filing export is handled outside MyGasLink for mini-operator accounts." />
          )
        )}
        {/* driver-statement-pdf catalog entry removed 2026-08-06 — the PDF
            is discoverable via Delivery Performance → Statement button. */}

        {/* Inline-kind entries (or fallback while catalog loads): the
            existing filter row + report table + chart flow. */}
        {(!selectedEntry || selectedEntry.kind === 'inline') && (<>
      {/* Report header — title + one-line description (2026-08-06).
          Sourced from the catalog entry so it stays in sync with the
          sidebar tooltip. Keeps the "what am I looking at" answer visible
          without a tooltip hover. */}
      {selectedEntry && (
        <div className="pb-1">
          <h2 className="text-lg font-semibold text-surface-900 dark:text-white">{selectedEntry.label}</h2>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-0.5">{selectedEntry.description}</p>
        </div>
      )}
      {/* Filters */}
      <div className="card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label text-xs">From</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input py-2 text-sm" />
          </div>
          <div>
            <label className="label text-xs">To</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input py-2 text-sm" />
          </div>
          {def?.filters.includes('customer') && (
            <div className="min-w-[260px]">
              <label className="label text-xs">Customer{def?.customerRequired ? ' *' : ''}</label>
              <CustomerSearchInput
                value={customerId}
                onChange={(id) => setCustomerId(id)}
                placeholder="Type 3+ letters to search…"
              />
            </div>
          )}
          {def?.filters.includes('cylinderType') && (
            <div className="min-w-[160px]">
              <label className="label text-xs">Cylinder Type</label>
              <Select value={cylinderTypeId} onChange={(e) => setCylinderTypeId(e.target.value)} placeholder="All types"
                options={(cylinderTypes ?? []).map((c) => ({ value: c.cylinderTypeId, label: c.typeName }))} />
            </div>
          )}
          {def?.filters.includes('driver') && (
            <div className="min-w-[160px]">
              <label className="label text-xs">Driver</label>
              <Select value={driverId} onChange={(e) => setDriverId(e.target.value)} placeholder="All drivers"
                options={(drivers ?? []).map((d) => ({ value: d.driverId, label: d.driverName }))} />
            </div>
          )}
          {def?.filters.includes('vehicle') && (
            <div className="min-w-[160px]">
              <label className="label text-xs">Vehicle</label>
              <Select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} placeholder="All vehicles"
                options={(vehicles ?? []).filter((v) => v.vehicleNumber).map((v) => ({ value: v.vehicleId, label: v.vehicleNumber as string }))} />
            </div>
          )}
          {def?.filters.includes('groupBy') && (
            <div>
              <label className="label text-xs">Group By</label>
              <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'day' | 'trip')}
                options={[{ value: 'day', label: 'Day' }, { value: 'trip', label: 'Trip' }]} />
            </div>
          )}
          {/* 2026-07-17: entry-date filter, currently only Payment Collections.
              Narrows by PaymentTransaction.createdAt (data-entry timestamp);
              stacks with the top-of-row Payment Date range. Both blank =
              no entry-date constraint (default). */}
          {def?.filters.includes('entryDate') && (
            <>
              <div>
                <label className="label text-xs">Entry Date From</label>
                <input type="date" value={entryDateFrom} onChange={(e) => setEntryDateFrom(e.target.value)} className="input py-2 text-sm" />
              </div>
              <div>
                <label className="label text-xs">Entry Date To</label>
                <input type="date" value={entryDateTo} onChange={(e) => setEntryDateTo(e.target.value)} className="input py-2 text-sm" />
              </div>
            </>
          )}
          {/* 2026-08-06 N18 Customer Profitability — AR interest rate is
              editable per-run per Suneel's "rate differs from time to time"
              spec (a cash-crunch quarter warrants 18%; a normal quarter
              runs 10-12%). Persisted per-user via reportPreferences (see
              saveCurrentAsPreset / applyPreset). Server clamps [0, 50]. */}
          {def?.filters.includes('arInterestRate') && (
            <div>
              <label className="label text-xs">AR Interest Rate (% / yr)</label>
              <input
                type="number"
                min="0"
                max="50"
                step="0.5"
                value={arInterestRatePct}
                onChange={(e) => setArInterestRatePct(e.target.value)}
                className="input py-2 text-sm w-32"
                placeholder="12"
              />
            </div>
          )}
          {/* 2026-08-05 F3 — Vehicle Ledger View selector removed. */}
          {/* Phase 1A — Filter preset picker (only for inline reports) */}
          {def && (
            <div className="min-w-[180px]">
              <label className="label text-xs">Preset</label>
              <Select
                value={activePresetId}
                onChange={(e) => applyPreset(e.target.value)}
                placeholder="No preset"
                options={presets.map((p) => ({ value: p.id, label: p.name }))}
              />
            </div>
          )}
          <div className="ml-auto flex flex-wrap gap-2 items-end">
            {def && (
              <Button variant="secondary" onClick={() => setSavePresetOpen(true)} title="Save current filters as a preset">
                Save filter…
              </Button>
            )}
            {def && activePresetId && (
              <Button variant="secondary" onClick={removeActivePreset} title="Delete the currently loaded preset">
                Delete preset
              </Button>
            )}
            {def && (
              <Button variant="secondary" onClick={() => setColumnsModalOpen(true)} title="Show / hide columns">
                Columns
                {hiddenColumns.size > 0 && (
                  <span className="ml-1 rounded bg-brand-100 text-brand-700 px-1.5 text-xs">{hiddenColumns.size}</span>
                )}
              </Button>
            )}
            <Button variant="secondary" onClick={resetDatesToDefault} title="Reset date range to default">
              Reset dates
            </Button>
            <Button variant="secondary" onClick={downloadCsv} loading={downloading} disabled={needsCustomer || !report}>
              <HiOutlineArrowDownTray className="h-4 w-4" /> CSV
            </Button>
            {reportKey === 'customer-statement' && (
              <Button variant="secondary" onClick={downloadPdf} loading={downloading} disabled={!customerId}>
                <HiOutlineDocumentArrowDown className="h-4 w-4" /> PDF
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ─── Phase 1A — Save Preset modal ─────────────────────────── */}
      <Modal open={savePresetOpen} onClose={() => setSavePresetOpen(false)} title="Save current filters as a preset">
        <div className="space-y-3">
          <div>
            <label className="label text-xs">Preset name</label>
            <input
              type="text"
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              placeholder="e.g. Monthly close — Ravi's routes"
              className="input"
              autoFocus
            />
          </div>
          <p className="text-xs text-surface-500">
            Saves the current dates + all filter values for this report. Overwrites if the name already exists.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSavePresetOpen(false)}>Cancel</Button>
            <Button onClick={saveCurrentAsPreset} disabled={!newPresetName.trim()}>Save preset</Button>
          </div>
        </div>
      </Modal>

      {/* ─── Phase 1B — Column visibility modal ───────────────────── */}
      <Modal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} title="Show / hide columns">
        <div className="space-y-3">
          {(report?.columns ?? []).length === 0 ? (
            <p className="text-sm text-surface-500">Load a report first to see its columns.</p>
          ) : (
            <>
              <p className="text-xs text-surface-500">
                Hidden columns disappear from the table. Note: CSV download still includes all columns.
              </p>
              <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto">
                {(report?.columns ?? []).map((c) => (
                  <label key={c.key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!hiddenColumns.has(c.key)}
                      onChange={() => toggleColumnVisibility(c.key)}
                    />
                    <span>{c.label}</span>
                  </label>
                ))}
              </div>
              <div className="flex justify-between">
                <Button variant="secondary" onClick={resetHiddenColumns}>Show all</Button>
                <Button onClick={() => setColumnsModalOpen(false)}>Done</Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      {needsCustomer ? (
        <EmptyState title="Select a customer" description="The Customer Statement report requires a customer." />
      ) : isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : isError ? (
        <EmptyState title="Could not load report" description={getErrorMessage(error)} />
      ) : !report || (report.rows.length === 0 && !report.secondary?.rows.length) ? (
        <EmptyState title="No data" description="No records match the selected filters." />
      ) : (
        <>
          {report.chart && <ReportChartView chart={report.chart} />}
          {reportKey === 'vehicle-ledger' ? (
            <UnifiedVehicleLedger report={report} />
          ) : reportKey === 'delivery-performance' ? (
            <DeliveryPerformanceTable
              report={report}
              expandedDrivers={expandedDrivers}
              onToggleDriver={(did) => {
                setExpandedDrivers((prev) => {
                  const next = new Set(prev);
                  if (next.has(did)) next.delete(did);
                  else next.add(did);
                  return next;
                });
              }}
              onDrillDown={(did, dname) => {
                setDrillDownDriverId(did);
                setDrillDownDriverName(dname);
              }}
            />
          ) : reportKey === 'driver-daily-log' ? (
            <DriverDailyLogTable report={report} />
          ) : (
            <>
              {report.secondary && report.secondary.rows.length > 0 && (
                <SecondaryTable table={report.secondary} />
              )}
              {report.rows.length > 0 && (
                <ReportTable
                  report={{
                    ...report,
                    // Phase 1B — apply column-visibility filter before render.
                    // Rows carry all keys; the table iterates `columns` and
                    // reads matching keys off each row, so hiding a column
                    // hides both header + cells with one filter.
                    columns: report.columns.filter((c) => !hiddenColumns.has(c.key)),
                  }}
                />
              )}
            </>
          )}
        </>
      )}

        </>)}
        {/* end inline-kind conditional */}

        {/* INVESTIGATION-JUL09 — Delivery Performance per-customer drill-down modal */}
        <DeliveryPerformanceDrillDownModal
          open={!!drillDownDriverId}
          driverId={drillDownDriverId}
          driverName={drillDownDriverName}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onClose={() => setDrillDownDriverId(null)}
        />
      </div>
      {/* end main content pane */}
    </div>
  );
}

// ─── Reports Sidebar (F2 2026-08-05) ────────────────────────────────────
// Left-nav that consumes the /api/reports/catalog response and renders
// 7 collapsible bucket headers, each listing its role-filtered entries.
// Kind icons: 📊 inline | ⬇ download | ↗ external. Selected entry gets
// the brand-color highlight. Buckets with 0 visible entries render as
// dimmed / disabled section headers (empty for now = "coming soon").
interface ReportsSidebarProps {
  catalog: ReportCatalogResponse | undefined;
  selectedSlug: string;
  onSelect: (slug: string) => void;
  isMiniOperator: boolean;
  savedReports: SavedReportDto[];
  onOpenSaved: (id: string) => void;
  onNewCustomReport: () => void;
}
function ReportsSidebar({ catalog, selectedSlug, onSelect, isMiniOperator, savedReports, onOpenSaved, onNewCustomReport }: ReportsSidebarProps) {
  // 2026-08-05 accordion behavior: exactly ONE bucket expanded at a time.
  // Clicking a collapsed bucket opens it + collapses any previously-open
  // bucket. Clicking an already-open bucket collapses it (nothing open).
  // Selecting a report auto-expands its parent bucket + collapses others.
  const [expandedBucket, setExpandedBucket] = useState<string | null>(null);

  // Auto-expand the bucket of the current selection whenever catalog
  // loads or selection changes to a different bucket (single-bucket mode).
  useEffect(() => {
    if (!catalog) return;
    const entry = catalog.entries.find((e) => e.slug === selectedSlug);
    if (entry) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- accordion auto-expand on selection change; guarded by prev-equality check so no cascade in the common case.
      setExpandedBucket((prev) => (prev === entry.bucket ? prev : entry.bucket));
    }
  }, [catalog, selectedSlug]);

  if (!catalog) {
    return (
      <div className="card p-4 flex justify-center"><Loader size="sm" /></div>
    );
  }

  // Accordion toggle: click open → close; click closed → replace with new.
  const toggleBucket = (key: string) => {
    setExpandedBucket((prev) => (prev === key ? null : key));
  };

  const kindGlyph = (kind: ReportCatalogEntry['kind']): string =>
    kind === 'download' ? '⬇' : kind === 'external' ? '↗' : '';

  // Sort buckets by declared order + filter entries by mini-op visibility
  // rule (Tally + GST filing hidden for mini-op per existing convention).
  const buckets = [...catalog.buckets].sort((a, b) => a.order - b.order);
  const entriesByBucket = new Map<string, ReportCatalogEntry[]>();
  for (const entry of catalog.entries) {
    if (isMiniOperator && (entry.slug === 'tally-export' || entry.slug === 'gst-filing-export')) continue;
    // 2026-08-13 (Suneel) — Tally hidden from the UI for now (paired with the
    // hidden Settings → Tally Setup tab). Hide the Tally Export report + its
    // setup-prompt panel for everyone. Restore by removing this line.
    if (entry.slug === 'tally-export') continue;
    const list = entriesByBucket.get(entry.bucket) ?? [];
    list.push(entry);
    entriesByBucket.set(entry.bucket, list);
  }

  return (
    // 2026-08-06 sidebar layout fix — sticky WITH its own max-height + scroll,
    // so long reports scroll independently instead of dragging the sidebar out
    // of view with them (the old shared-scroll caused users to lose the nav
    // when scrolling to the bottom of tall reports like Payment Method Mix).
    <nav className="card p-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
      <ul className="space-y-0.5">
        {buckets.map((bucket) => {
          const entries = entriesByBucket.get(bucket.key) ?? [];
          const isOpen = expandedBucket === bucket.key;
          const isEmpty = entries.length === 0;
          return (
            <li key={bucket.key}>
              <button
                type="button"
                onClick={() => !isEmpty && toggleBucket(bucket.key)}
                // 2026-08-06 bucket typography — uppercase + wider tracking so
                // the bucket header (Daily Book / Invoicing & Payments / …)
                // reads as a category label, out-weighing the softer child
                // pill below. Matches the "My Custom Reports" section header
                // treatment for consistency.
                className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-left transition ${
                  isEmpty
                    ? 'text-surface-400 cursor-default'
                    : 'text-surface-900 dark:text-surface-100 hover:bg-surface-100 dark:hover:bg-surface-800'
                }`}
                disabled={isEmpty}
                title={bucket.description}
              >
                {isEmpty ? (
                  <span className="w-4" />
                ) : isOpen ? (
                  <HiOutlineChevronDown className="h-4 w-4 flex-shrink-0" />
                ) : (
                  <HiOutlineChevronRight className="h-4 w-4 flex-shrink-0" />
                )}
                <span className="flex-1">{bucket.label}</span>
                <span className="text-[10px] text-surface-400 tabular-nums font-normal normal-case">{entries.length || ''}</span>
              </button>
              {isOpen && !isEmpty && (
                <ul className="mt-0.5 mb-1 space-y-0.5">
                  {entries.map((entry) => {
                    const active = entry.slug === selectedSlug;
                    return (
                      <li key={entry.slug}>
                        <button
                          type="button"
                          onClick={() => onSelect(entry.slug)}
                          // 2026-08-06 selected-entry treatment softened —
                          // was `bg-brand-600 text-white` (visually dominated
                          // its bucket header). Now `bg-brand-50 + brand-700
                          // text + left border` reads clearly as "selected
                          // child of the bold bucket above".
                          className={`w-full flex items-start gap-2 pl-9 pr-3 py-1.5 rounded-lg text-sm text-left transition border-l-2 ${
                            active
                              ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-200 font-medium border-brand-500'
                              : 'text-surface-700 dark:text-surface-300 border-transparent hover:bg-surface-100 dark:hover:bg-surface-800'
                          }`}
                          title={entry.description}
                        >
                          <span className="flex-1 min-w-0 truncate">{entry.label}</span>
                          {kindGlyph(entry.kind) && (
                            <span className={`text-xs flex-shrink-0 ${active ? 'text-white/70' : 'text-surface-400'}`}>
                              {kindGlyph(entry.kind)}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}

        {/* ─── My Custom Reports (Phase 2) ─────────────────────── */}
        <li>
          <div className="border-t border-surface-200 dark:border-surface-700 my-1" />
          <div className="px-3 py-2 text-xs font-semibold text-surface-500 uppercase tracking-wide flex items-center justify-between">
            <span>👤 My Custom Reports</span>
            <button
              type="button"
              onClick={onNewCustomReport}
              className="text-brand-600 hover:text-brand-800 flex items-center gap-0.5 text-xs normal-case font-medium"
              title="Build a new custom report"
            >
              <HiOutlinePlus className="h-3 w-3" /> New
            </button>
          </div>
          {savedReports.length === 0 ? (
            <p className="px-3 py-1 text-xs text-surface-400">No custom reports yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {savedReports.map((sr) => (
                <li key={sr.id}>
                  <button
                    type="button"
                    onClick={() => onOpenSaved(sr.id)}
                    className="w-full flex items-start gap-2 pl-3 pr-3 py-1.5 rounded-lg text-sm text-left text-surface-700 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 transition"
                    title={sr.description ?? sr.name}
                  >
                    <span className="flex-1 min-w-0 truncate">{sr.name}</span>
                    {sr.visibility === 'distributor' && (
                      <span className="text-xs text-surface-400" title="Shared with everyone in company">🏢</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </li>
      </ul>
    </nav>
  );
}

// 2026-08-06 (FX-H) — sortable column headers. Click a header to sort asc,
// click again to reverse, click a third time to clear. Sort is client-side
// (already-fetched rows) so it's instant. Money columns and count columns
// sort numerically; the rest sort by locale-string. Falls back to insertion
// order for equal values (stable sort — Array.prototype.sort is stable in V8).
// The totals row is NEVER included in the sortable body; it stays pinned
// to the bottom.
function ReportTable({ report }: { report: ReportResult }) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const clickSort = (key: string) => {
    if (sortKey !== key) { setSortKey(key); setSortDir('asc'); return; }
    if (sortDir === 'asc') { setSortDir('desc'); return; }
    setSortKey(null); // third click: clear sort → original insertion order
  };

  const sortedRows = useMemo(() => {
    if (!sortKey) return report.rows;
    const col = report.columns.find((c) => c.key === sortKey);
    const isNumeric = col?.money || report.rows.some((r) => {
      const v = r[sortKey];
      return typeof v === 'number';
    });
    const sign = sortDir === 'asc' ? 1 : -1;
    const copy = [...report.rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      // Nulls always sort to the end regardless of direction — matches
      // spreadsheet behavior. Null vs null is equal.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (isNumeric) return (Number(av) - Number(bv)) * sign;
      return String(av).localeCompare(String(bv)) * sign;
    });
    return copy;
  }, [report.rows, report.columns, sortKey, sortDir]);

  const sortGlyph = (key: string) => {
    if (sortKey !== key) return <span className="ml-1 text-surface-300 dark:text-surface-600">⇅</span>;
    return <span className="ml-1 text-brand-500">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  };

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-surface-200 dark:border-surface-700 text-left">
            {report.columns.map((c) => (
              <th
                key={c.key}
                onClick={() => clickSort(c.key)}
                className={`px-4 py-3 font-semibold text-surface-600 dark:text-surface-300 cursor-pointer select-none hover:bg-surface-100 dark:hover:bg-surface-800/50 ${c.money ? 'text-right' : ''}`}
                title="Click to sort. Click again to reverse. Third click resets."
              >
                <span className={c.money ? 'inline-flex items-center flex-row-reverse gap-0' : 'inline-flex items-center'}>
                  <span>{c.label}</span>
                  {sortGlyph(c.key)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, i) => (
            <tr key={i} className={`border-b border-surface-100 dark:border-surface-800 ${isOverdueRow(row) ? 'bg-danger-50 dark:bg-danger-900/20' : ''}`}>
              {report.columns.map((c) => (
                <td key={c.key} className={`px-4 py-2.5 ${c.money ? 'text-right tabular-nums' : ''} ${isOverdueRow(row) ? 'text-danger-700 dark:text-danger-300' : 'text-surface-800 dark:text-surface-200'}`}>
                  {fmtCell(row[c.key], c)}
                </td>
              ))}
            </tr>
          ))}
          {report.totals && (
            <tr className="border-t-2 border-surface-300 dark:border-surface-600 font-bold bg-surface-50 dark:bg-surface-800/50">
              {report.columns.map((c) => (
                <td key={c.key} className={`px-4 py-3 ${c.money ? 'text-right tabular-nums' : ''} text-surface-900 dark:text-white`}>
                  {report.totals![c.key] === '' || report.totals![c.key] == null ? '' : fmtCell(report.totals![c.key], c)}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SecondaryTable({ table }: { table: ReportTableData }) {
  return (
    <div className="card overflow-x-auto">
      <h3 className="px-4 pt-4 font-semibold text-surface-900 dark:text-white">{table.title}</h3>
      <table className="w-full text-sm mt-2">
        <thead>
          <tr className="border-b border-surface-200 dark:border-surface-700 text-left">
            {table.columns.map((c) => (
              <th key={c.key} className={`px-4 py-3 font-semibold text-surface-600 dark:text-surface-300 ${c.money ? 'text-right' : ''}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i} className="border-b border-surface-100 dark:border-surface-800">
              {table.columns.map((c) => (
                <td key={c.key} className={`px-4 py-2.5 ${c.money ? 'text-right tabular-nums' : ''} text-surface-800 dark:text-surface-200`}>
                  {fmtCell(row[c.key], c)}
                </td>
              ))}
            </tr>
          ))}
          {table.totals && (
            <tr className="border-t-2 border-surface-300 dark:border-surface-600 font-bold bg-surface-50 dark:bg-surface-800/50">
              {table.columns.map((c) => (
                <td key={c.key} className={`px-4 py-3 ${c.money ? 'text-right tabular-nums' : ''} text-surface-900 dark:text-white`}>
                  {table.totals![c.key] === '' || table.totals![c.key] == null ? '' : fmtCell(table.totals![c.key], c)}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── Vehicle Ledger table (2026-08-05 rewrite: F3 + F9 + F4) ───────────────
// Trimmed columns per Suneel: Date | Vehicle | Driver | Trip | Cylinder |
// Dispatched | Delivered | Returned | Empties Returned | Outstanding.
//
//   Returned    = Dispatched − Delivered (fulls that came back undelivered
//                 — cancellations, lost-in-transit, undelivered write-offs)
//   Outstanding = Delivered − Empties Returned (empties customer still owes
//                 back for this trip; positive means they hold N cylinders)
//
// F3 — the old "Corporation Loads Received" secondary table + the "View"
// selector (All / Corporation / Trips) are gone. Corporation inbound loads
// live on Inventory → Depot History exclusively.
//
// F4 sticky columns — the first three data columns (Date / Vehicle /
// Driver) are pinned via `position: sticky; left: <px>`. On narrow
// viewports, the numeric columns scroll horizontally but the identity
// context stays visible. Uses matching background colors so the sticky
// cells don't bleed through the underlying content.
//
// Totals row rendered at the bottom (backend emits `report.totals`;
// pre-2026-08-05 the collapse dropped this on the floor).

interface TripRow {
  date: string;
  vehicleNumber: string;
  driverName: string;
  tripNumber: string;
  cylinderType: string;
  fullsDispatched: number;
  fullsDelivered: number;
  returnedFulls: number;
  emptiesCollected: number;
  outstandingEmpties: number;
}

function toTripRow(r: Record<string, ReportCellValue>): TripRow {
  const n = (v: ReportCellValue | undefined): number => (typeof v === 'number' ? v : 0);
  return {
    date: String(r.date ?? r.tripDate ?? r.eventDate ?? ''),
    vehicleNumber: String(r.vehicleNumber ?? ''),
    driverName: String(r.driverName ?? ''),
    tripNumber: String(r.tripNumber ?? '—'),
    cylinderType: String(r.cylinderType ?? r.cylinderTypeName ?? ''),
    fullsDispatched: n(r.fullsDispatched),
    fullsDelivered: n(r.fullsDelivered),
    returnedFulls: n(r.returnedFulls),
    emptiesCollected: n(r.emptiesCollected),
    outstandingEmpties: n(r.outstandingEmpties),
  };
}

// Sticky-column widths must sum to a stable pixel offset so left:XX px
// on each sticky cell lines up. If any of Date/Vehicle/Driver column
// widths change, update these offsets in lockstep.
const STICKY = {
  date:    { left: 0,   width: 108 }, // yyyy-mm-dd fits at 12px
  vehicle: { left: 108, width: 128 }, // "TS09AB1234" etc.
  driver:  { left: 236, width: 140 }, // driver name
};

// Sticky-column class helpers. The per-column `left` and `min-width` are
// applied via inline `style` at each call site (see STICKY.* offsets) so
// the tailwind class stays a static string.
const STICKY_TH = 'px-4 py-3 font-semibold text-surface-600 dark:text-surface-300 sticky bg-white dark:bg-surface-900 z-10';
const STICKY_TD = 'px-4 py-2.5 text-surface-800 dark:text-surface-200 sticky bg-white dark:bg-surface-900';

function UnifiedVehicleLedger({ report }: { report: ReportResult }) {
  const rows: TripRow[] = (report.rows ?? []).map(toTripRow);
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  if (rows.length === 0) {
    return (
      <div className="card p-8 text-center text-surface-400 text-sm">
        No records match the selected filters.
      </div>
    );
  }

  const t = report.totals ?? {};
  const tn = (k: string): number => (typeof t[k] === 'number' ? (t[k] as number) : 0);

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-surface-200 dark:border-surface-700 text-left">
            <th className={STICKY_TH} style={{ left: STICKY.date.left, minWidth: STICKY.date.width }}>Date</th>
            <th className={STICKY_TH} style={{ left: STICKY.vehicle.left, minWidth: STICKY.vehicle.width }}>Vehicle</th>
            <th className={STICKY_TH} style={{ left: STICKY.driver.left, minWidth: STICKY.driver.width }}>Driver</th>
            <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300">Trip</th>
            <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300">Cylinder</th>
            <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300 text-right">Dispatched</th>
            <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300 text-right">Delivered</th>
            <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300 text-right">Returned</th>
            <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300 text-right">Empties Returned</th>
            <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300 text-right">Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-surface-100 dark:border-surface-800">
              <td className={STICKY_TD} style={{ left: STICKY.date.left, minWidth: STICKY.date.width }}>{formatDisplayDate(row.date)}</td>
              <td className={STICKY_TD} style={{ left: STICKY.vehicle.left, minWidth: STICKY.vehicle.width }}>{row.vehicleNumber}</td>
              <td className={STICKY_TD} style={{ left: STICKY.driver.left, minWidth: STICKY.driver.width }}>{row.driverName}</td>
              <td className="px-4 py-2.5 text-surface-800 dark:text-surface-200">{row.tripNumber}</td>
              <td className="px-4 py-2.5 text-surface-800 dark:text-surface-200">{row.cylinderType}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-surface-800 dark:text-surface-200">{row.fullsDispatched}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-surface-800 dark:text-surface-200">{row.fullsDelivered}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-surface-800 dark:text-surface-200">{row.returnedFulls}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-surface-800 dark:text-surface-200">{row.emptiesCollected}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-surface-800 dark:text-surface-200">{row.outstandingEmpties}</td>
            </tr>
          ))}
          {/* Totals row — backend emits report.totals. Bold + top border. */}
          <tr className="border-t-2 border-surface-300 dark:border-surface-600 font-semibold bg-surface-50 dark:bg-surface-800/50">
            <td className={`${STICKY_TD} font-semibold !bg-surface-50 dark:!bg-surface-800/50`} style={{ left: STICKY.date.left, minWidth: STICKY.date.width + STICKY.vehicle.width + STICKY.driver.width }} colSpan={3}>TOTAL</td>
            <td className="px-4 py-2.5"></td>
            <td className="px-4 py-2.5"></td>
            <td className="px-4 py-2.5 text-right tabular-nums">{tn('fullsDispatched')}</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{tn('fullsDelivered')}</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{tn('returnedFulls')}</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{tn('emptiesCollected')}</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{tn('outstandingEmpties')}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ReportChartView({ chart }: { chart: ReportChart }) {
  return (
    <div className="card p-4">
      <h3 className="font-semibold text-surface-900 dark:text-white mb-3">{chart.title}</h3>
      {chart.type === 'line'
        ? <LineChart data={chart.data as LineChartData} />
        : <StackedBarChart data={chart.data as BarChartData} />}
    </div>
  );
}

// 2026-08-06 (FX-I) chart helpers — compact ₹ format for y-axis ticks
// (₹1,73,100 → ₹1.7L; ₹1,23,45,678 → ₹1.2Cr). Indian number system, not
// US. Rounds to 1 decimal.
function fmtCompactINR(n: number): string {
  if (n == null || !Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `₹${(n / 10_000_000).toFixed(1)}Cr`;
  if (abs >= 100_000) return `₹${(n / 100_000).toFixed(1)}L`;
  if (abs >= 1_000) return `₹${(n / 1_000).toFixed(1)}K`;
  return `₹${n.toFixed(0)}`;
}
// Choose 4-6 evenly-spaced y-axis ticks based on max. Round the top tick
// up to a nice number so gridlines land on 100 / 500 / 1000 / etc.
function niceTicks(max: number, targetCount = 5): number[] {
  if (max <= 0) return [0];
  const rough = max / targetCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  const step = (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  return ticks;
}

// Compact date label — 2026-08-04 → "4 Aug", 2026-08 → "Aug '26"
function fmtAxisLabel(x: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(x)) {
    const d = new Date(x + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }
  if (/^\d{4}-\d{2}$/.test(x)) {
    const [y, m] = x.split('-');
    const d = new Date(Number(y), Number(m) - 1, 1);
    return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
  }
  return x;
}

// Dependency-free SVG line chart. Full axes + gridlines + rotated x labels
// + hover tooltips + y-axis title. Rendered at 720×260 with 56/48/32/16
// margins (L/B/T/R) to leave room for tick labels.
function LineChart({ data }: { data: LineChartData }) {
  if (!data?.length) return <p className="text-sm text-surface-400">No data</p>;
  const W = 720, H = 260;
  const M = { top: 20, right: 20, bottom: 56, left: 64 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const max = Math.max(...data.map((d) => d.y), 1);
  const ticks = niceTicks(max, 5);
  const yMax = ticks[ticks.length - 1];
  const stepX = data.length > 1 ? plotW / (data.length - 1) : 0;
  const xOf = (i: number) => M.left + i * stepX;
  const yOf = (v: number) => M.top + plotH - (v / yMax) * plotH;
  const pts = data.map((d, i) => `${xOf(i)},${yOf(d.y)}`).join(' ');
  // Show at most ~10 x-axis labels (skip step to avoid overlap on long ranges).
  const xLabelStep = Math.max(1, Math.ceil(data.length / 10));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-64" role="img" aria-label="Line chart">
      {/* Gridlines + y-axis ticks */}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={M.left} x2={M.left + plotW} y1={yOf(t)} y2={yOf(t)} className="stroke-surface-200 dark:stroke-surface-700" strokeWidth={1} strokeDasharray={t === 0 ? '0' : '2 3'} />
          <text x={M.left - 8} y={yOf(t) + 3} textAnchor="end" className="fill-surface-500 dark:fill-surface-400 text-[10px]">{fmtCompactINR(t)}</text>
        </g>
      ))}
      {/* Y-axis title (rotated) */}
      <text x={16} y={M.top + plotH / 2} transform={`rotate(-90 16 ${M.top + plotH / 2})`} textAnchor="middle" className="fill-surface-500 dark:fill-surface-400 text-[11px] font-medium">Revenue</text>
      {/* X-axis line */}
      <line x1={M.left} y1={M.top + plotH} x2={M.left + plotW} y2={M.top + plotH} className="stroke-surface-400 dark:stroke-surface-600" strokeWidth={1} />
      {/* Line + points */}
      <polyline points={pts} fill="none" className="stroke-brand-500" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      {data.map((d, i) => (
        <g key={i}>
          <circle cx={xOf(i)} cy={yOf(d.y)} r={3.5} className="fill-brand-600" />
          <title>{`${d.x}\n${fmtCompactINR(d.y)}`}</title>
        </g>
      ))}
      {/* X-axis tick labels — rotated 45° so long date strings don't collide */}
      {data.map((d, i) => (i % xLabelStep === 0) && (
        <text
          key={`x-${i}`}
          x={xOf(i)}
          y={M.top + plotH + 14}
          textAnchor="end"
          transform={`rotate(-45 ${xOf(i)} ${M.top + plotH + 14})`}
          className="fill-surface-500 dark:fill-surface-400 text-[10px]"
        >{fmtAxisLabel(d.x)}</text>
      ))}
    </svg>
  );
}

// Dependency-free SVG stacked-bar chart with same axis polish as LineChart.
// Palette uses brand + amber + emerald + sky + rose + violet so up to 6
// series get distinct colors without a picker.
function StackedBarChart({ data }: { data: BarChartData }) {
  const seriesColors = [
    { fill: 'fill-brand-500', bg: 'bg-brand-500' },
    { fill: 'fill-amber-400', bg: 'bg-amber-400' },
    { fill: 'fill-emerald-500', bg: 'bg-emerald-500' },
    { fill: 'fill-sky-500', bg: 'bg-sky-500' },
    { fill: 'fill-rose-500', bg: 'bg-rose-500' },
    { fill: 'fill-violet-500', bg: 'bg-violet-500' },
  ];
  if (!data?.labels?.length) return <p className="text-sm text-surface-400">No data</p>;
  const totals = data.labels.map((_, i) => data.series.reduce((s, ser) => s + (ser.values[i] || 0), 0));
  const max = Math.max(...totals, 1);
  const ticks = niceTicks(max, 5);
  const yMax = ticks[ticks.length - 1];
  const W = 720, H = 280;
  const M = { top: 20, right: 20, bottom: 56, left: 64 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const groupW = plotW / data.labels.length;
  const bw = Math.min(50, groupW - 10);
  const yOf = (v: number) => M.top + plotH - (v / yMax) * plotH;
  const xLabelStep = Math.max(1, Math.ceil(data.labels.length / 12));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-72" role="img" aria-label="Stacked bar chart">
        {/* Gridlines + y-axis ticks */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={M.left + plotW} y1={yOf(t)} y2={yOf(t)} className="stroke-surface-200 dark:stroke-surface-700" strokeWidth={1} strokeDasharray={t === 0 ? '0' : '2 3'} />
            <text x={M.left - 8} y={yOf(t) + 3} textAnchor="end" className="fill-surface-500 dark:fill-surface-400 text-[10px]">{fmtCompactINR(t)}</text>
          </g>
        ))}
        {/* Y-axis title */}
        <text x={16} y={M.top + plotH / 2} transform={`rotate(-90 16 ${M.top + plotH / 2})`} textAnchor="middle" className="fill-surface-500 dark:fill-surface-400 text-[11px] font-medium">Amount</text>
        {/* X-axis line */}
        <line x1={M.left} y1={M.top + plotH} x2={M.left + plotW} y2={M.top + plotH} className="stroke-surface-400 dark:stroke-surface-600" strokeWidth={1} />
        {/* Bars + labels */}
        {data.labels.map((lbl, i) => {
          const xCenter = M.left + (i + 0.5) * groupW;
          let yCursor = M.top + plotH;
          return (
            <g key={i}>
              {data.series.map((ser, si) => {
                const v = ser.values[i] || 0;
                const h = (v / yMax) * plotH;
                yCursor -= h;
                return (
                  <rect key={si} x={xCenter - bw / 2} y={yCursor} width={bw} height={h} className={seriesColors[si % seriesColors.length].fill}>
                    <title>{`${lbl} · ${ser.name}\n${fmtCompactINR(v)}`}</title>
                  </rect>
                );
              })}
              {(i % xLabelStep === 0) && (
                <text
                  x={xCenter}
                  y={M.top + plotH + 14}
                  textAnchor="end"
                  transform={`rotate(-45 ${xCenter} ${M.top + plotH + 14})`}
                  className="fill-surface-500 dark:fill-surface-400 text-[10px]"
                >{fmtAxisLabel(lbl)}</text>
              )}
            </g>
          );
        })}
      </svg>
      {/* Legend — one chip per series with matching color */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 justify-center">
        {data.series.map((ser, si) => (
          <span key={si} className="flex items-center gap-1.5 text-xs text-surface-700 dark:text-surface-300">
            <span className={`inline-block h-3 w-3 rounded-sm ${seriesColors[si % seriesColors.length].bg}`} />
            {ser.name}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── INVESTIGATION-JUL09 — Delivery Performance custom table ─────────────────
//
// Backend sends a flat rows array containing two row-shapes distinguished by
// `type`:
//   • driver_summary — money + fulls + empties aggregated across all
//     cylinder types for one driver. Rendered with an expand chevron.
//   • cylinder_row   — per-cylinder-type fulls/empties for one driver.
//     Rendered indented; visible only when the parent driver is expanded.
// Money columns are intentionally blank on cylinder_row so per-cylinder rows
// never appear to have their own money — avoids the double-count trap when
// an order spans multiple cylinder types.
function DeliveryPerformanceTable({
  report,
  expandedDrivers,
  onToggleDriver,
  onDrillDown,
}: {
  report: ReportResult;
  expandedDrivers: Set<string>;
  onToggleDriver: (driverId: string) => void;
  onDrillDown: (driverId: string, driverName: string) => void;
}) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-surface-200 dark:border-surface-700 text-left">
            <th className="px-4 py-3 w-8"></th>
            {report.columns.map((c) => (
              <th key={c.key} className={`px-4 py-3 font-semibold text-surface-600 dark:text-surface-300 ${c.money ? 'text-right' : ''}`}>{c.label}</th>
            ))}
            <th className="px-4 py-3 w-8"></th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, i) => {
            const rowType = String(row.type ?? '');
            const isSummary = rowType === 'driver_summary';
            const isCylRow = rowType === 'cylinder_row';
            const driverId = String(row.driverId ?? '');
            const expanded = expandedDrivers.has(driverId);
            // Top-level view: only render driver_summary and (when expanded)
            // cylinder_row. Any customer_row rows returned in a shared cache
            // from a CSV-flavoured response never leak into the table.
            if (!isSummary && !isCylRow) return null;
            if (isCylRow && !expanded) return null;

            return (
              <tr
                key={i}
                className={`border-b border-surface-100 dark:border-surface-800 ${isSummary ? 'font-medium bg-surface-50 dark:bg-surface-800/40' : 'text-surface-600 dark:text-surface-400'}`}
              >
                <td className="px-2 py-2.5">
                  {isSummary && (
                    <button
                      onClick={() => onToggleDriver(driverId)}
                      className="text-surface-500 hover:text-surface-800 dark:hover:text-white"
                      aria-label={expanded ? 'Collapse cylinder breakdown' : 'Expand cylinder breakdown'}
                    >
                      {expanded ? <HiOutlineChevronDown className="h-4 w-4" /> : <HiOutlineChevronRight className="h-4 w-4" />}
                    </button>
                  )}
                </td>
                {report.columns.map((c) => {
                  const raw = row[c.key];
                  const isCylTypeCol = c.key === 'cylinderTypeName';
                  return (
                    <td
                      key={c.key}
                      className={`px-4 py-2.5 ${c.money ? 'text-right tabular-nums' : ''} ${!isSummary && isCylTypeCol ? 'pl-10' : ''}`}
                    >
                      {c.money ? (raw === '' || raw == null ? '' : fmtMoney(raw)) : String(raw ?? '')}
                    </td>
                  );
                })}
                <td className="px-2 py-2.5">
                  {isSummary && (
                    <button
                      onClick={() => onDrillDown(driverId, String(row.driverName ?? ''))}
                      className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-800 dark:text-brand-400"
                      title="View driver statement — every invoice this driver touched in the period"
                    >
                      <HiOutlineUserGroup className="h-4 w-4" />
                      Statement
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {report.totals && (
            <tr className="border-t-2 border-surface-300 dark:border-surface-600 font-bold bg-surface-100 dark:bg-surface-800/60">
              <td></td>
              {report.columns.map((c) => (
                <td key={c.key} className={`px-4 py-3 ${c.money ? 'text-right tabular-nums' : ''} text-surface-900 dark:text-white`}>
                  {report.totals![c.key] === '' || report.totals![c.key] == null
                    ? ''
                    : c.money
                      ? fmtMoney(report.totals![c.key])
                      : String(report.totals![c.key])}
                </td>
              ))}
              <td></td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── DriverDailyLogTable (2026-08-06) ───────────────────────────────────
// Backend sends parent driver-day rows immediately followed by their
// trip children (per driverDailyLog service in reportsService.ts). Each
// row carries `type: 'driver_day' | 'trip'` — this table hides trip
// children by default and renders a chevron on parent rows to toggle
// them. Mirrors the DeliveryPerformanceTable shape (driver_summary +
// cylinder_row) but grouped by (date, driver) instead of (driver only).
function DriverDailyLogTable({ report }: { report: ReportResult }) {
  // Key format: `${date}|${driverId}`. When expanded, the matching
  // trip children (whose driverId matches AND appear immediately after
  // the parent until the next driver_day row) render inline.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const parentKey = (row: Record<string, ReportCellValue>) => `${String(row.date)}|${String(row.driverId)}`;

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-surface-200 dark:border-surface-700 text-left">
            <th className="px-3 py-3 w-8"></th>
            {report.columns.map((c) => (
              <th key={c.key} className={`px-4 py-3 font-semibold text-surface-600 dark:text-surface-300 ${c.money ? 'text-right' : ''}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(() => {
            // Precompute per-row "is my parent expanded" in one pass so
            // the render map below stays pure (no let-mutation across
            // iterations — React Compiler flags that). Parent rows'
            // "expanded" is derived from state; child rows inherit from
            // the most recent parent above them.
            const rowExpandedFlag: boolean[] = [];
            let lastParentExpanded = false;
            for (const row of report.rows) {
              if (String(row.type ?? '') === 'driver_day') {
                lastParentExpanded = expanded.has(parentKey(row));
                rowExpandedFlag.push(lastParentExpanded);
              } else {
                rowExpandedFlag.push(lastParentExpanded);
              }
            }
            return report.rows.map((row, i) => {
              const rowType = String(row.type ?? '');
              const isExpanded = rowExpandedFlag[i];
              if (rowType === 'driver_day') {
                const k = parentKey(row);
                return (
                  <tr
                    key={i}
                    className="border-b border-surface-100 dark:border-surface-800 font-medium bg-surface-50 dark:bg-surface-800/40 cursor-pointer hover:bg-surface-100 dark:hover:bg-surface-800/70"
                    onClick={() => toggle(k)}
                  >
                    <td className="px-2 py-2.5 text-surface-500">
                      {isExpanded ? <HiOutlineChevronDown className="h-4 w-4" /> : <HiOutlineChevronRight className="h-4 w-4" />}
                    </td>
                    {report.columns.map((c) => {
                      const raw = row[c.key];
                      return (
                        <td key={c.key} className={`px-4 py-2.5 ${c.money ? 'text-right tabular-nums' : ''} text-surface-900 dark:text-white`}>
                          {c.money ? (raw === '' || raw == null ? '—' : fmtMoney(raw)) : String(raw ?? '')}
                        </td>
                      );
                    })}
                  </tr>
                );
              }
              // Trip child — render only when its parent is expanded.
              // Trip rows share the same driverId as the immediately-preceding
              // parent; the currentParentExpanded flag reflects that state.
              if (rowType !== 'trip') return null;
              if (!isExpanded) return null;
              return (
                <tr
                  key={i}
                  className="border-b border-surface-100 dark:border-surface-800 text-surface-600 dark:text-surface-400 bg-white dark:bg-surface-900/30"
                >
                  <td className="px-2 py-2"></td>
                  {report.columns.map((c) => {
                    const raw = row[c.key];
                    // Indent the first non-blank data cell (Trip label sits
                    // in the "trip" column). Date + driver blank on children;
                    // trip column carries the child identity.
                    const isTripCol = c.key === 'trip';
                    return (
                      <td key={c.key} className={`px-4 py-2 ${c.money ? 'text-right tabular-nums' : ''} ${isTripCol ? 'pl-8 italic' : ''}`}>
                        {c.money ? (raw === '' || raw == null ? '' : fmtMoney(raw)) : String(raw ?? '')}
                      </td>
                    );
                  })}
                </tr>
              );
            });
          })()}
          {report.totals && (
            <tr className="border-t-2 border-surface-300 dark:border-surface-600 font-bold bg-surface-100 dark:bg-surface-800/60">
              <td></td>
              {report.columns.map((c) => {
                const raw = report.totals![c.key];
                return (
                  <td key={c.key} className={`px-4 py-3 ${c.money ? 'text-right tabular-nums' : ''} text-surface-900 dark:text-white`}>
                    {raw === '' || raw == null ? '' : (c.money ? fmtMoney(raw) : String(raw))}
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      </table>
      <p className="px-4 py-2 text-xs text-surface-500 dark:text-surface-400 border-t border-surface-100 dark:border-surface-800">
        Click a driver-day row to expand per-trip detail. Totals reflect all rows regardless of expand state.
      </p>
    </div>
  );
}

// Driver Statement modal — per-invoice detail listing with status filter,
// KPI summary strip, and CSV + PDF export. Replaces the previous per-
// customer drill-down modal (customer name is a column in the table so
// customer-level breakdown is still readable, but per-invoice is where
// the ops team actually operates).
type StatusFilter = 'all' | 'paid' | 'partial' | 'pending' | 'overdue';

function DeliveryPerformanceDrillDownModal({
  open,
  driverId,
  driverName,
  dateFrom,
  dateTo,
  onClose,
}: {
  open: boolean;
  driverId: string | null;
  driverName: string;
  dateFrom: string;
  dateTo: string;
  onClose: () => void;
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['report', 'delivery-performance', 'statement', driverId, dateFrom, dateTo, statusFilter],
    queryFn: () =>
      apiGet<ReportResult>('/reports/delivery-performance', {
        dateFrom,
        dateTo,
        driverId: driverId!,
        groupBy: 'invoice',
        statusFilter,
      }),
    enabled: !!driverId && open,
  });

  // KPI counts + sums are attached to totals as _kpiCounts / _kpiSums by the
  // backend so the chip badges reflect the FULL breakdown even while the
  // table is showing a subset.
  const totals = (data?.totals ?? {}) as Record<string, unknown>;
  const kpiCounts = (totals._kpiCounts as { paid: number; partial: number; pending: number; overdue: number } | undefined) ?? {
    paid: 0, partial: 0, pending: 0, overdue: 0,
  };
  const kpiSums = (totals._kpiSums as { billed: number; collected: number; pending: number; overdue: number } | undefined) ?? {
    billed: 0, collected: 0, pending: 0, overdue: 0,
  };
  const allCount = kpiCounts.paid + kpiCounts.partial + kpiCounts.pending + kpiCounts.overdue;

  async function downloadStatement(format: 'csv' | 'pdf') {
    if (!driverId) return;
    try {
      const url = format === 'pdf'
        ? `/reports/delivery-performance/driver/${driverId}/pdf`
        : `/reports/delivery-performance`;
      const params: Record<string, unknown> = { dateFrom, dateTo, statusFilter };
      if (format === 'csv') { params.driverId = driverId; params.groupBy = 'invoice'; params.format = 'csv'; }
      const res = await api.get(url, { params, responseType: 'blob' });
      const filename = `driver-statement-${driverName.replace(/\s+/g, '_')}-${dateFrom}_${dateTo}.${format}`;
      const href = window.URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = href; a.download = filename; a.click();
      window.URL.revokeObjectURL(href);
      toast.success(`${format.toUpperCase()} downloaded`);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  }

  const chipButton = (key: StatusFilter, label: string, count: number, tone: string) => (
    <button
      key={key}
      onClick={() => setStatusFilter(key)}
      className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
        statusFilter === key
          ? `${tone} ring-2 ring-offset-1 ring-brand-500`
          : `${tone} opacity-70 hover:opacity-100`
      }`}
    >
      {label} <span className="ml-1 font-bold">{count}</span>
    </button>
  );

  return (
    <Modal open={open} onClose={onClose} title={`Driver Statement — ${driverName}`} size="full">
      {/* KPI strip + filter chips + export buttons */}
      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap gap-4 text-sm">
          <span className="font-semibold text-surface-700 dark:text-surface-300">
            {allCount} invoice{allCount === 1 ? '' : 's'}
          </span>
          <span className="text-surface-500 dark:text-surface-400">·</span>
          <span>Billed: <span className="font-semibold">{fmtMoney(kpiSums.billed)}</span></span>
          <span>Collected: <span className="font-semibold text-emerald-600 dark:text-emerald-400">{fmtMoney(kpiSums.collected)}</span></span>
          <span>Pending: <span className="font-semibold text-amber-600 dark:text-amber-400">{fmtMoney(kpiSums.pending)}</span></span>
          <span>Overdue: <span className="font-semibold text-rose-600 dark:text-rose-400">{fmtMoney(kpiSums.overdue)}</span></span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {chipButton('all', 'All', allCount, 'bg-surface-100 dark:bg-surface-800 text-surface-800 dark:text-surface-200')}
          {chipButton('paid', 'Paid', kpiCounts.paid, 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300')}
          {chipButton('partial', 'Partial', kpiCounts.partial, 'bg-sky-100 dark:bg-sky-900/40 text-sky-800 dark:text-sky-300')}
          {chipButton('pending', 'Pending', kpiCounts.pending, 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300')}
          {chipButton('overdue', 'Overdue', kpiCounts.overdue, 'bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-300')}
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => downloadStatement('csv')} disabled={!data || data.rows.length === 0}>
              <HiOutlineArrowDownTray className="h-4 w-4" /> CSV
            </Button>
            <Button variant="secondary" onClick={() => downloadStatement('pdf')} disabled={!data || data.rows.length === 0}>
              <HiOutlineDocumentArrowDown className="h-4 w-4" /> PDF
            </Button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader size="lg" /></div>
      ) : isError ? (
        <EmptyState title="Could not load statement" description={getErrorMessage(error)} />
      ) : !data || data.rows.length === 0 ? (
        <EmptyState title="No invoices" description={`No ${statusFilter === 'all' ? '' : statusFilter + ' '}invoices for ${driverName} in ${dateFrom} — ${dateTo}.`} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-200 dark:border-surface-700 text-left">
                {data.columns.map((c) => (
                  <th key={c.key} className={`px-3 py-2 font-semibold text-surface-600 dark:text-surface-300 ${c.money ? 'text-right' : ''}`}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => {
                const status = String(row.status ?? '');
                const rowBg =
                  status === 'Overdue' ? 'bg-rose-50/50 dark:bg-rose-900/10'
                  : status === 'Paid' ? 'bg-emerald-50/50 dark:bg-emerald-900/10'
                  : '';
                return (
                  <tr key={i} className={`border-b border-surface-100 dark:border-surface-800 ${rowBg}`}>
                    {data.columns.map((c) => {
                      const raw = row[c.key];
                      const isStatusCol = c.key === 'status';
                      const statusChip =
                        raw === 'Paid' ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300'
                        : raw === 'Partial' ? 'bg-sky-100 dark:bg-sky-900/40 text-sky-800 dark:text-sky-300'
                        : raw === 'Pending' ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300'
                        : raw === 'Overdue' ? 'bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-300'
                        : '';
                      return (
                        <td key={c.key} className={`px-3 py-2 ${c.money ? 'text-right tabular-nums' : ''}`}>
                          {isStatusCol && raw ? (
                            <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusChip}`}>{String(raw)}</span>
                          ) : c.money ? (
                            raw === '' || raw == null ? '' : fmtMoney(raw)
                          ) : (
                            String(raw ?? '')
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {data.totals && (
                <tr className="border-t-2 border-surface-300 dark:border-surface-600 font-bold bg-surface-100 dark:bg-surface-800/60">
                  {data.columns.map((c) => (
                    <td key={c.key} className={`px-3 py-2 ${c.money ? 'text-right tabular-nums' : ''} text-surface-900 dark:text-white`}>
                      {data.totals![c.key] === '' || data.totals![c.key] == null
                        ? ''
                        : c.money
                          ? fmtMoney(data.totals![c.key])
                          : String(data.totals![c.key])}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-surface-500 dark:text-surface-400">
            Fulls Split / Empties Split break the per-invoice totals down by cylinder type (e.g. &ldquo;5×19 KG, 2×47.5 LOT&rdquo;).
          </p>
        </div>
      )}
    </Modal>
  );
}
