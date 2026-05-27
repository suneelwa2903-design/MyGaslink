import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { HiOutlineArrowDownTray, HiOutlineDocumentArrowDown } from 'react-icons/hi2';
import { api, apiGet, getErrorMessage } from '@/lib/api';
import { Button, Select, Loader, EmptyState } from '@/components/ui';

type ReportCellValue = string | number | null;
type LineChartData = { x: string; y: number }[];
type BarChartData = { labels: string[]; series: { name: string; values: number[] }[] };
interface ReportColumn { key: string; label: string; money?: boolean }
interface ReportChart { type: 'line' | 'bar'; title: string; data: LineChartData | BarChartData }
interface ReportResult { columns: ReportColumn[]; rows: Record<string, ReportCellValue>[]; totals?: Record<string, ReportCellValue>; chart?: ReportChart }

type FilterKey = 'cylinderType' | 'driver' | 'customer';
interface ReportDef { key: string; label: string; filters: FilterKey[]; customerRequired?: boolean }

const REPORTS: ReportDef[] = [
  { key: 'sales-summary', label: 'Sales Summary', filters: ['cylinderType'] },
  { key: 'outstanding-aging', label: 'Outstanding & Aging', filters: [] },
  { key: 'gst-summary', label: 'GST Summary', filters: [] },
  { key: 'delivery-performance', label: 'Delivery Performance', filters: ['driver'] },
  { key: 'inventory-movement', label: 'Inventory Movement', filters: ['cylinderType'] },
  { key: 'customer-statement', label: 'Customer Statement', filters: ['customer'], customerRequired: true },
];

const fmtMoney = (v: ReportCellValue | undefined) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const isOverdueRow = (r: Record<string, ReportCellValue>) => Number(r.b31_60 || 0) > 0 || Number(r.b60plus || 0) > 0;

function todayStr() { return new Date().toISOString().slice(0, 10); }
function monthAgoStr() { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 10); }

export default function ReportsPage() {
  const [reportKey, setReportKey] = useState('sales-summary');
  const [dateFrom, setDateFrom] = useState(monthAgoStr());
  const [dateTo, setDateTo] = useState(todayStr());
  const [cylinderTypeId, setCylinderTypeId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [downloading, setDownloading] = useState(false);

  const def = REPORTS.find((r) => r.key === reportKey)!;

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

  const params = useMemo(() => {
    const p: Record<string, unknown> = { dateFrom, dateTo };
    if (def.filters.includes('cylinderType') && cylinderTypeId) p.cylinderTypeId = cylinderTypeId;
    if (def.filters.includes('driver') && driverId) p.driverId = driverId;
    if (def.filters.includes('customer') && customerId) p.customerId = customerId;
    return p;
  }, [dateFrom, dateTo, cylinderTypeId, driverId, customerId, def]);

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

  const downloadCsv = () => downloadBlob(`/reports/${reportKey}`, { ...params, format: 'csv' }, `${reportKey}-${dateFrom}_${dateTo}.csv`);
  const downloadPdf = () => customerId && downloadBlob(`/customers/${customerId}/ledger/pdf`, { from: dateFrom, to: dateTo }, `statement-${dateFrom}_${dateTo}.pdf`);

  return (
    <div className="space-y-6">
      {/* Report selector */}
      <div className="flex flex-wrap gap-2">
        {REPORTS.map((r) => (
          <button
            key={r.key}
            onClick={() => setReportKey(r.key)}
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
      ) : !report || report.rows.length === 0 ? (
        <EmptyState title="No data" description="No records match the selected filters." />
      ) : (
        <>
          {report.chart && <ReportChartView chart={report.chart} />}
          <ReportTable report={report} />
        </>
      )}
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
