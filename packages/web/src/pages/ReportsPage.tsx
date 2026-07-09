import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { HiOutlineArrowDownTray, HiOutlineChevronDown, HiOutlineChevronRight, HiOutlineDocumentArrowDown, HiOutlineUserGroup } from 'react-icons/hi2';
import { localTodayISO, localDateISO } from '@gaslink/shared';
import { api, apiGet, getErrorMessage } from '@/lib/api';
import { Button, Select, Loader, EmptyState, Modal } from '@/components/ui';
import TallyExportPanel from '@/components/reports/TallyExportPanel';

type ReportCellValue = string | number | null;
type LineChartData = { x: string; y: number }[];
type BarChartData = { labels: string[]; series: { name: string; values: number[] }[] };
interface ReportColumn { key: string; label: string; money?: boolean }
interface ReportChart { type: 'line' | 'bar'; title: string; data: LineChartData | BarChartData }
interface ReportTableData { title: string; columns: ReportColumn[]; rows: Record<string, ReportCellValue>[]; totals?: Record<string, ReportCellValue> }
interface ReportResult { columns: ReportColumn[]; rows: Record<string, ReportCellValue>[]; totals?: Record<string, ReportCellValue>; chart?: ReportChart; secondary?: ReportTableData }

type FilterKey = 'cylinderType' | 'driver' | 'customer' | 'vehicle' | 'groupBy';
interface ReportDef { key: string; label: string; filters: FilterKey[]; customerRequired?: boolean }

const REPORTS: ReportDef[] = [
  { key: 'sales-summary', label: 'Sales Summary', filters: ['cylinderType'] },
  { key: 'outstanding-aging', label: 'Outstanding & Aging', filters: [] },
  { key: 'gst-summary', label: 'GST Summary', filters: [] },
  { key: 'delivery-performance', label: 'Delivery Performance', filters: ['driver'] },
  { key: 'inventory-movement', label: 'Inventory Movement', filters: ['cylinderType'] },
  { key: 'customer-statement', label: 'Customer Statement', filters: ['customer'], customerRequired: true },
  { key: 'vehicle-ledger', label: 'Vehicle Ledger', filters: ['vehicle', 'driver', 'cylinderType', 'groupBy'] },
];

const fmtMoney = (v: ReportCellValue | undefined) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const isOverdueRow = (r: Record<string, ReportCellValue>) => Number(r.b31_60 || 0) > 0 || Number(r.b60plus || 0) > 0;

function todayStr() { return localTodayISO(); }
function monthAgoStr() { const d = new Date(); d.setMonth(d.getMonth() - 1); return localDateISO(d); }
// INVESTIGATION-JUL09: delivery-performance defaults to yesterday..today so
// the operator lands on "yesterday's numbers" — the most-asked view.
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate() - 1); return localDateISO(d); }

export default function ReportsPage() {
  const [reportKey, setReportKey] = useState('sales-summary');
  const [dateFrom, setDateFrom] = useState(monthAgoStr());
  const [dateTo, setDateTo] = useState(todayStr());
  const [cylinderTypeId, setCylinderTypeId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [groupBy, setGroupBy] = useState<'day' | 'trip'>('day');
  // WI-5 — Vehicle Ledger View dropdown: All / Corporation Loads Only /
  // Vehicle Trips Only. Client-side filter over the unified table; the
  // backend continues to return both primary (trips) and secondary
  // (corporation loads) so other reports remain unaffected.
  const [vehicleLedgerView, setVehicleLedgerView] = useState<'all' | 'corporation' | 'trips'>('all');
  const [downloading, setDownloading] = useState(false);
  // INVESTIGATION-JUL09 — Delivery Performance drill-down state.
  // Which driver's customer breakdown is open in the modal, if any.
  const [drillDownDriverId, setDrillDownDriverId] = useState<string | null>(null);
  const [drillDownDriverName, setDrillDownDriverName] = useState<string>('');
  // Which top-level driver_summary rows are expanded to show cylinder_row children.
  const [expandedDrivers, setExpandedDrivers] = useState<Set<string>>(new Set());

  const def = REPORTS.find((r) => r.key === reportKey)!;

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

  // Filter option data (lazy/shared)
  const { data: customers } = useQuery({
    queryKey: ['report-customers'],
    queryFn: () => apiGet<{ customers: { customerId: string; customerName: string }[] }>('/customers', { pageSize: 100 }),
    select: (d) => d.customers,
  });
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
    if (def.filters.includes('cylinderType') && cylinderTypeId) p.cylinderTypeId = cylinderTypeId;
    if (def.filters.includes('driver') && driverId) p.driverId = driverId;
    if (def.filters.includes('customer') && customerId) p.customerId = customerId;
    if (def.filters.includes('vehicle') && vehicleId) p.vehicleId = vehicleId;
    if (def.filters.includes('groupBy')) p.groupBy = groupBy;
    return p;
  }, [dateFrom, dateTo, cylinderTypeId, driverId, customerId, vehicleId, groupBy, def]);

  const needsCustomer = def.customerRequired && !customerId;

  const { data: report, isLoading, isError, error } = useQuery({
    queryKey: ['report', reportKey, params],
    queryFn: () => apiGet<ReportResult>(`/reports/${reportKey}`, params),
    enabled: !needsCustomer,
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

  return (
    <div className="space-y-6">
      {/* Tally Export — separate from the per-report selector below
          because it's an accounting-software bulk export, not a printable
          report. Picks up dateFrom/dateTo from the same filter row. */}
      <TallyExportPanel dateFrom={dateFrom} dateTo={dateTo} />

      {/* Report selector */}
      <div className="flex flex-wrap gap-2">
        {REPORTS.map((r) => (
          <button
            key={r.key}
            onClick={() => pickReport(r.key)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${reportKey === r.key ? 'bg-brand-600 text-white' : 'bg-surface-100 dark:bg-surface-800 text-surface-700 dark:text-surface-300 hover:bg-surface-200'}`}
          >
            {r.label}
          </button>
        ))}
      </div>

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
          {def.filters.includes('customer') && (
            <div className="min-w-[200px]">
              <label className="label text-xs">Customer{def.customerRequired ? ' *' : ''}</label>
              <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="Select customer"
                options={(customers ?? []).map((c) => ({ value: c.customerId, label: c.customerName }))} />
            </div>
          )}
          {def.filters.includes('cylinderType') && (
            <div className="min-w-[160px]">
              <label className="label text-xs">Cylinder Type</label>
              <Select value={cylinderTypeId} onChange={(e) => setCylinderTypeId(e.target.value)} placeholder="All types"
                options={(cylinderTypes ?? []).map((c) => ({ value: c.cylinderTypeId, label: c.typeName }))} />
            </div>
          )}
          {def.filters.includes('driver') && (
            <div className="min-w-[160px]">
              <label className="label text-xs">Driver</label>
              <Select value={driverId} onChange={(e) => setDriverId(e.target.value)} placeholder="All drivers"
                options={(drivers ?? []).map((d) => ({ value: d.driverId, label: d.driverName }))} />
            </div>
          )}
          {def.filters.includes('vehicle') && (
            <div className="min-w-[160px]">
              <label className="label text-xs">Vehicle</label>
              <Select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} placeholder="All vehicles"
                options={(vehicles ?? []).filter((v) => v.vehicleNumber).map((v) => ({ value: v.vehicleId, label: v.vehicleNumber as string }))} />
            </div>
          )}
          {def.filters.includes('groupBy') && (
            <div>
              <label className="label text-xs">Group By</label>
              <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'day' | 'trip')}
                options={[{ value: 'day', label: 'Day' }, { value: 'trip', label: 'Trip' }]} />
            </div>
          )}
          {/* WI-5 — View filter, Vehicle Ledger only */}
          {reportKey === 'vehicle-ledger' && (
            <div>
              <label className="label text-xs">View</label>
              <Select
                value={vehicleLedgerView}
                onChange={(e) => setVehicleLedgerView(e.target.value as 'all' | 'corporation' | 'trips')}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'corporation', label: 'Corporation Loads Only' },
                  { value: 'trips', label: 'Vehicle Trips Only' },
                ]}
              />
            </div>
          )}
          <div className="ml-auto flex gap-2">
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
            <UnifiedVehicleLedger report={report} view={vehicleLedgerView} />
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
          ) : (
            <>
              {report.secondary && report.secondary.rows.length > 0 && (
                <SecondaryTable table={report.secondary} />
              )}
              {report.rows.length > 0 && <ReportTable report={report} />}
            </>
          )}
        </>
      )}

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
  );
}

function ReportTable({ report }: { report: ReportResult }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-surface-200 dark:border-surface-700 text-left">
            {report.columns.map((c) => (
              <th key={c.key} className={`px-4 py-3 font-semibold text-surface-600 dark:text-surface-300 ${c.money ? 'text-right' : ''}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, i) => (
            <tr key={i} className={`border-b border-surface-100 dark:border-surface-800 ${isOverdueRow(row) ? 'bg-danger-50 dark:bg-danger-900/20' : ''}`}>
              {report.columns.map((c) => (
                <td key={c.key} className={`px-4 py-2.5 ${c.money ? 'text-right tabular-nums' : ''} ${isOverdueRow(row) ? 'text-danger-700 dark:text-danger-300' : 'text-surface-800 dark:text-surface-200'}`}>
                  {c.money ? fmtMoney(row[c.key]) : String(row[c.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
          {report.totals && (
            <tr className="border-t-2 border-surface-300 dark:border-surface-600 font-bold bg-surface-50 dark:bg-surface-800/50">
              {report.columns.map((c) => (
                <td key={c.key} className={`px-4 py-3 ${c.money ? 'text-right tabular-nums' : ''} text-surface-900 dark:text-white`}>
                  {report.totals![c.key] === '' || report.totals![c.key] == null ? '' : (c.money ? fmtMoney(report.totals![c.key]) : String(report.totals![c.key]))}
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
                  {c.money ? fmtMoney(row[c.key]) : String(row[c.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
          {table.totals && (
            <tr className="border-t-2 border-surface-300 dark:border-surface-600 font-bold bg-surface-50 dark:bg-surface-800/50">
              {table.columns.map((c) => (
                <td key={c.key} className={`px-4 py-3 ${c.money ? 'text-right tabular-nums' : ''} text-surface-900 dark:text-white`}>
                  {table.totals![c.key] === '' || table.totals![c.key] == null ? '' : (c.money ? fmtMoney(table.totals![c.key]) : String(table.totals![c.key]))}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── WI-5 — Vehicle Ledger unified table ────────────────────────────────────
// Renders a single table with a Type column ("Corporation" or "Trip"), with
// a View filter that scopes to one source or both. Date sort: desc. When the
// view is "Corporation Only", trip-only columns are dropped from the header.
// When the view is "Vehicle Trips Only", the corporation column set is hidden.

interface UnifiedRow {
  type: 'Corporation' | 'Trip';
  date: string;
  vehicleNumber: string;
  driverName: string;
  cylinderType: string;
  documentNumber: string;
  quantity: number | string;
  // The raw row carried through for trip-specific columns.
  raw: Record<string, ReportCellValue>;
}

function UnifiedVehicleLedger({ report, view }: { report: ReportResult; view: 'all' | 'corporation' | 'trips' }) {
  const tripRows: UnifiedRow[] = (report.rows ?? []).map((r) => ({
    type: 'Trip',
    date: String(r.date ?? r.tripDate ?? r.eventDate ?? ''),
    vehicleNumber: String(r.vehicleNumber ?? ''),
    driverName: String(r.driverName ?? ''),
    cylinderType: String(r.cylinderType ?? r.cylinderTypeName ?? ''),
    documentNumber: '',
    quantity: r.fullsDispatched ?? r.deliveredQty ?? r.collectedEmpties ?? '',
    raw: r,
  }));
  const corporationRows: UnifiedRow[] = (report.secondary?.rows ?? []).map((r) => ({
    type: 'Corporation',
    date: String(r.date ?? ''),
    vehicleNumber: '—',
    driverName: '—',
    cylinderType: String(r.cylinderType ?? ''),
    documentNumber: String(r.documentNumber ?? ''),
    quantity: r.quantity ?? '',
    raw: r,
  }));

  const filtered =
    view === 'corporation' ? corporationRows
      : view === 'trips' ? tripRows
      : [...corporationRows, ...tripRows];

  // Sort by date desc (string compare on yyyy-mm-dd is fine; non-iso falls
  // back to localeCompare).
  filtered.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  if (filtered.length === 0) {
    return (
      <div className="card p-8 text-center text-surface-400 text-sm">
        No records match the selected filters.
      </div>
    );
  }

  // Column set depends on the view.
  const showType = view === 'all';
  const showVehicle = view !== 'corporation';
  const showDriver = view !== 'corporation';
  const showDocument = view !== 'trips';

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-surface-200 dark:border-surface-700 text-left">
            <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300">Date</th>
            {showType && <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300">Type</th>}
            {showVehicle && <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300">Vehicle</th>}
            {showDriver && <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300">Driver</th>}
            <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300">Cylinder</th>
            {showDocument && <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300">Doc / Ref</th>}
            <th className="px-4 py-3 font-semibold text-surface-600 dark:text-surface-300 text-right">Quantity</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((row, i) => (
            <tr key={`${row.type}-${i}`} className="border-b border-surface-100 dark:border-surface-800">
              <td className="px-4 py-2.5 text-surface-800 dark:text-surface-200">{row.date}</td>
              {showType && (
                <td className="px-4 py-2.5">
                  <span className={
                    row.type === 'Corporation'
                      ? 'badge-info'
                      : 'badge-neutral'
                  }>
                    {row.type}
                  </span>
                </td>
              )}
              {showVehicle && <td className="px-4 py-2.5 text-surface-800 dark:text-surface-200">{row.vehicleNumber}</td>}
              {showDriver && <td className="px-4 py-2.5 text-surface-800 dark:text-surface-200">{row.driverName}</td>}
              <td className="px-4 py-2.5 text-surface-800 dark:text-surface-200">{row.cylinderType}</td>
              {showDocument && <td className="px-4 py-2.5 text-surface-800 dark:text-surface-200">{row.documentNumber || '—'}</td>}
              <td className="px-4 py-2.5 text-right tabular-nums text-surface-800 dark:text-surface-200">{String(row.quantity ?? '')}</td>
            </tr>
          ))}
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

// Minimal dependency-free SVG line chart for { x, y }[]
function LineChart({ data }: { data: LineChartData }) {
  if (!data?.length) return <p className="text-sm text-surface-400">No data</p>;
  const W = 720, H = 200, pad = 32;
  const max = Math.max(...data.map((d) => d.y), 1);
  const stepX = data.length > 1 ? (W - pad * 2) / (data.length - 1) : 0;
  const pts = data.map((d, i) => {
    const x = pad + i * stepX;
    const y = H - pad - (d.y / max) * (H - pad * 2);
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-48">
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="stroke-surface-300" strokeWidth={1} />
      <polyline points={pts} fill="none" className="stroke-brand-500" strokeWidth={2} />
      {data.map((d, i) => {
        const x = pad + i * stepX;
        const y = H - pad - (d.y / max) * (H - pad * 2);
        return <circle key={i} cx={x} cy={y} r={3} className="fill-brand-600" />;
      })}
      <text x={pad} y={14} className="fill-surface-400 text-[10px]">max ₹{max.toLocaleString('en-IN')}</text>
    </svg>
  );
}

// Minimal stacked bar chart for { labels:[], series:[{name, values:[]}] }
function StackedBarChart({ data }: { data: BarChartData }) {
  const colors = ['fill-brand-500', 'fill-amber-400', 'fill-danger-500'];
  if (!data?.labels?.length) return <p className="text-sm text-surface-400">No data</p>;
  const totals = data.labels.map((_, i) => data.series.reduce((s, ser) => s + (ser.values[i] || 0), 0));
  const max = Math.max(...totals, 1);
  const W = 720, H = 220, pad = 32;
  const bw = Math.min(60, (W - pad * 2) / data.labels.length - 12);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-56">
        {data.labels.map((lbl, i) => {
          const xCenter = pad + (i + 0.5) * ((W - pad * 2) / data.labels.length);
          let yCursor = H - pad;
          return (
            <g key={i}>
              {data.series.map((ser, si) => {
                const h = ((ser.values[i] || 0) / max) * (H - pad * 2);
                yCursor -= h;
                return <rect key={si} x={xCenter - bw / 2} y={yCursor} width={bw} height={h} className={colors[si % colors.length]} />;
              })}
              <text x={xCenter} y={H - pad + 14} textAnchor="middle" className="fill-surface-500 text-[10px]">{lbl}</text>
            </g>
          );
        })}
      </svg>
      <div className="flex gap-4 mt-2">
        {data.series.map((ser, si) => (
          <span key={si} className="flex items-center gap-1 text-xs text-surface-600 dark:text-surface-300">
            <span className={`inline-block h-3 w-3 rounded-sm ${colors[si % colors.length].replace('fill-', 'bg-')}`} />{ser.name}
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
            E Pend is a customer-level cumulative pending-empty balance (across all drivers that ever served that customer) — the same number every driver visiting that customer will see.
          </p>
        </div>
      )}
    </Modal>
  );
}
