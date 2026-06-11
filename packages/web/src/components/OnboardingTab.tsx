import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Button, Loader, Modal } from '@/components/ui';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { useAuthStore, selectDistributorId } from '@/stores/authStore';
import { cn } from '@/lib/cn';

type Step = { key: string; label: string; done: boolean; optional?: boolean; link: string };
type Progress = { steps: Step[]; requiredDoneCount: number; requiredTotal: number; show: boolean };

// Minimal CSV parser supporting quoted fields with embedded commas/quotes.
// Returns header row + array of object rows.
function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { cur.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (field !== '' || cur.length > 0) { cur.push(field); lines.push(cur); cur = []; field = ''; }
        if (ch === '\r' && text[i + 1] === '\n') i++;
      } else field += ch;
    }
  }
  if (field !== '' || cur.length > 0) { cur.push(field); lines.push(cur); }

  const headers = (lines.shift() ?? []).map((h) => h.trim());
  const rows = lines
    .filter((l) => l.length > 0 && l.some((v) => v.trim() !== ''))
    .map((l) => Object.fromEntries(headers.map((h, i) => [h, (l[i] ?? '').trim()])));
  return { headers, rows };
}

// Group 3 (2026-06-11): expanded CSV templates.
// Customer template now includes structured address columns + email +
// transport charge. Single-column `address` is still accepted (back-compat)
// and is auto-parsed into pincode/state/line1 by the importer.
// Opening-balance template adds `phone` (fallback lookup) and `as_of_date`.
// Group D2 (2026-06-11): shipping address columns added. Optional —
// when shipping_* are absent, billing values are still used for delivery
// flows; when present, the customer ships to a separate location (common
// for chain stores / commercial customers with a central billing office).
const CUSTOMER_TEMPLATE =
  'name,phone,business_name,address,line1,line2,city,state,pincode,shipping_line1,shipping_line2,shipping_city,shipping_state,shipping_pincode,gstin,email,credit_period_days,customer_type,transport_charge\n' +
  'Royal Kitchen Restaurant,9876543210,Royal Kitchen Pvt Ltd,,123 Main Street,,Hyderabad,Telangana,500001,,,,,,36AABCU9603R1ZX,royal@example.com,30,commercial,15\n' +
  'Green Valley Home,9876543211,,"456 Colony Road, Hyderabad, Telangana, 500032",,,,,,,,,,,,,0,domestic,\n';
const OPENING_BAL_TEMPLATE =
  'customer_name,phone,opening_balance,as_of_date,notes\n' +
  'Royal Kitchen Restaurant,9876543210,15000,2026-05-31,Outstanding as of paper register\n' +
  'Green Valley Home,9876543211,2500,,\n';
// Group 4 (2026-06-11): per-customer opening empty cylinder counts.
// cylinder_type must match an existing CylinderType.typeName for this
// distributor (e.g. "19 KG", "5 KG").
const EMPTY_BAL_TEMPLATE =
  'customer_name,phone,cylinder_type,empty_quantity\n' +
  'Royal Kitchen Restaurant,9876543210,19 KG,3\n' +
  'Royal Kitchen Restaurant,9876543210,5 KG,1\n' +
  'Green Valley Home,9876543211,19 KG,2\n';

function downloadCsv(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function OnboardingTab() {
  const qc = useQueryClient();
  const distributorId = useAuthStore(selectDistributorId);
  const { data: progress, isLoading } = useQuery<Progress>({
    queryKey: ['onboarding-progress', distributorId],
    queryFn: () => apiGet<Progress>('/customers/onboarding/progress'),
    enabled: !!distributorId,
  });

  const dismiss = useMutation({
    mutationFn: () => apiPost('/customers/onboarding/dismiss'),
    onSuccess: () => { toast.success('Onboarding dismissed'); qc.invalidateQueries({ queryKey: ['onboarding-progress'] }); },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const [importer, setImporter] = useState<'customers' | 'opening-balances' | 'empty-balances' | null>(null);
  const [openingStockOpen, setOpeningStockOpen] = useState(false);

  if (isLoading) return <div className="flex justify-center py-10"><Loader /></div>;
  if (!progress) return null;

  const pct = progress.requiredTotal === 0 ? 100 : Math.round((progress.requiredDoneCount / progress.requiredTotal) * 100);

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-surface-900 dark:text-white">Get started</h3>
            <p className="text-xs text-surface-500 mt-1">{progress.requiredDoneCount} of {progress.requiredTotal} required steps complete</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => dismiss.mutate()}>Dismiss</Button>
        </div>
        <div className="h-2 bg-surface-100 dark:bg-surface-700 rounded-full overflow-hidden mb-4">
          <div className="h-full bg-brand-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="space-y-2">
          {progress.steps.map((s, i) => {
            // Fix E (2026-06-11): every step has an actionable destination.
            // Steps with a dedicated modal on this very tab open it directly.
            // The super-admin-only `go_live_date` step shows a non-clickable
            // tooltip instead of a dead navigation.
            const inner = (
              <>
                <div className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold ${s.done ? 'bg-accent-500 text-white' : 'bg-surface-200 dark:bg-surface-700 text-surface-500'}`}>
                  {s.done ? '✓' : i + 1}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-surface-900 dark:text-white">{s.label} {s.optional && <span className="text-xs text-surface-400">(optional)</span>}</p>
                </div>
                <span className="text-xs text-brand-600 dark:text-brand-400">→</span>
              </>
            );
            const className = 'flex items-center gap-3 p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50 hover:bg-surface-100 dark:hover:bg-surface-700/50 transition-colors text-left w-full';

            // Modal-on-this-tab steps
            if (s.key === 'opening_stock') {
              return <button key={s.key} type="button" onClick={() => setOpeningStockOpen(true)} className={className}>{inner}</button>;
            }
            if (s.key === 'opening_balances') {
              return <button key={s.key} type="button" onClick={() => setImporter('opening-balances')} className={className}>{inner}</button>;
            }
            if (s.key === 'opening_empties') {
              return <button key={s.key} type="button" onClick={() => setImporter('empty-balances')} className={className}>{inner}</button>;
            }

            // Super-admin-only: clicking does nothing actionable for KN —
            // show a tooltip and DO NOT navigate.
            if (s.key === 'go_live_date') {
              return (
                <div
                  key={s.key}
                  className={cn(className, 'cursor-default')}
                  title="Contact your platform administrator (mygaslink.com support) to set your go-live date."
                >
                  {inner}
                </div>
              );
            }

            // Smart link overrides for steps where the backend's single
            // `link` field doesn't cover both failure shapes (e.g. types
            // exist but prices don't; drivers exist but logins don't).
            let href = s.link;
            if (s.key === 'cylinder_types') href = '/app/settings?tab=prices';
            if (s.key === 'drivers') href = '/app/users';
            if (s.key === 'doc_code' || s.key === 'godown_address') href = '/app/settings?tab=general';
            if (s.key === 'test_order') href = '/app/orders';

            return <a key={s.key} href={href} className={className}>{inner}</a>;
          })}
        </div>
      </div>

      <div className="card p-5">
        <h3 className="font-semibold text-surface-900 dark:text-white mb-4">Bulk import</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="p-4 rounded-xl border border-surface-200 dark:border-surface-700">
            <p className="font-medium text-surface-900 dark:text-white">Import customers</p>
            <p className="text-xs text-surface-500 mt-1">CSV: name, phone, address (auto-parsed) or line1/city/state/pincode, optional shipping_*, business_name, gstin, email, credit_period_days, customer_type</p>
            <div className="flex gap-2 mt-3">
              <Button variant="ghost" size="sm" onClick={() => downloadCsv('customers-template.csv', CUSTOMER_TEMPLATE)}>Download template</Button>
              <Button size="sm" onClick={() => setImporter('customers')}>Upload CSV</Button>
            </div>
          </div>
          <div className="p-4 rounded-xl border border-surface-200 dark:border-surface-700">
            <p className="font-medium text-surface-900 dark:text-white">Import opening balances</p>
            <p className="text-xs text-surface-500 mt-1">CSV with columns: customer_name, phone, opening_balance, as_of_date, notes</p>
            <div className="flex gap-2 mt-3">
              <Button variant="ghost" size="sm" onClick={() => downloadCsv('opening-balances-template.csv', OPENING_BAL_TEMPLATE)}>Download template</Button>
              <Button size="sm" onClick={() => setImporter('opening-balances')}>Upload CSV</Button>
            </div>
          </div>
          <div className="p-4 rounded-xl border border-surface-200 dark:border-surface-700">
            <p className="font-medium text-surface-900 dark:text-white">Import empty cylinders held by customers</p>
            <p className="text-xs text-surface-500 mt-1">CSV with columns: customer_name, phone, cylinder_type, empty_quantity</p>
            <div className="flex gap-2 mt-3">
              <Button variant="ghost" size="sm" onClick={() => downloadCsv('empty-balances-template.csv', EMPTY_BAL_TEMPLATE)}>Download template</Button>
              <Button size="sm" onClick={() => setImporter('empty-balances')}>Upload CSV</Button>
            </div>
          </div>
        </div>
      </div>

      {importer === 'customers' && <CustomerImportModal onClose={() => { setImporter(null); qc.invalidateQueries({ queryKey: ['onboarding-progress'] }); }} />}
      {importer === 'opening-balances' && <OpeningBalanceImportModal onClose={() => { setImporter(null); qc.invalidateQueries({ queryKey: ['onboarding-progress'] }); }} />}
      {importer === 'empty-balances' && <EmptyBalanceImportModal onClose={() => { setImporter(null); qc.invalidateQueries({ queryKey: ['onboarding-progress'] }); }} />}
      {openingStockOpen && <OpeningStockModal onClose={() => { setOpeningStockOpen(false); qc.invalidateQueries({ queryKey: ['onboarding-progress'] }); }} />}
    </div>
  );
}

type CylinderTypeRow = { cylinderTypeId: string; typeName: string; capacity: number; unit: string };

function OpeningStockModal({ onClose }: { onClose: () => void }) {
  const distributorId = useAuthStore(selectDistributorId);
  const { data: types, isLoading } = useQuery<CylinderTypeRow[]>({
    queryKey: ['cylinder-types-active', distributorId],
    queryFn: async () => {
      const r = await apiGet<{ cylinderTypes: CylinderTypeRow[] }>('/cylinder-types');
      return r.cylinderTypes;
    },
    enabled: !!distributorId,
  });

  const [entries, setEntries] = useState<Record<string, { fulls: string; empties: string }>>({});
  // Group 2 (2026-06-11): as-of-date picker. Defaults to today; max=today
  // (cannot future-date opening stock).
  const todayStr = new Date().toISOString().split('T')[0];
  const [eventDate, setEventDate] = useState<string>(todayStr);

  // Group 2: 409 OPENING_STOCK_CONFLICT confirmation state. When the
  // backend reports existing initial_balance events, we surface the
  // current values and ask the user to confirm a replace.
  type Conflict = { cylinderTypeId: string; fulls: number; empties: number; eventDate: string };
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);

  const setVal = (id: string, field: 'fulls' | 'empties', v: string) => {
    setEntries((prev) => ({ ...prev, [id]: { fulls: prev[id]?.fulls ?? '', empties: prev[id]?.empties ?? '', [field]: v } }));
  };

  const buildPayload = (replaceExisting: boolean) => {
    const items = (types ?? [])
      .map((t) => {
        const e = entries[t.cylinderTypeId];
        const fulls = Number(e?.fulls ?? '0') || 0;
        const empties = Number(e?.empties ?? '0') || 0;
        return { cylinderTypeId: t.cylinderTypeId, openingFulls: fulls, openingEmpties: empties };
      })
      .filter((e) => e.openingFulls > 0 || e.openingEmpties > 0);
    if (items.length === 0) throw new Error('Enter at least one opening balance');
    return { entries: items, eventDate, replaceExisting };
  };

  const submit = useMutation({
    mutationFn: (replaceExisting: boolean) =>
      apiPost<{ created: number; replaced?: number }>('/inventory/initial-balance', buildPayload(replaceExisting)),
    onSuccess: (r) => {
      const replacedSuffix = r.replaced && r.replaced > 0 ? ` (replaced ${r.replaced})` : '';
      toast.success(`Opening stock saved (${r.created} cylinder type${r.created === 1 ? '' : 's'})${replacedSuffix}`);
      setConflicts(null);
      onClose();
    },
    onError: (e: unknown) => {
      // Axios error: look for our 409 OPENING_STOCK_CONFLICT shape and
      // surface a confirmation panel instead of a toast.
      const ax = e as { response?: { status?: number; data?: { code?: string; details?: { conflicts?: Conflict[] } } } };
      const data = ax?.response?.data;
      if (ax?.response?.status === 409 && data?.code === 'OPENING_STOCK_CONFLICT' && data?.details?.conflicts?.length) {
        setConflicts(data.details.conflicts);
        return;
      }
      toast.error(getErrorMessage(e));
    },
  });

  const typeName = (id: string) => (types ?? []).find((t) => t.cylinderTypeId === id)?.typeName ?? id;

  return (
    <Modal open onClose={onClose} title="Enter Opening Stock" size="lg">
      <div className="space-y-4">
        <p className="text-sm text-surface-500">Enter your stock count. Leave a row at zero to skip it.</p>
        <div>
          <label className="label">Stock count date</label>
          <input
            type="date"
            className="input py-2 max-w-[200px]"
            value={eventDate}
            max={todayStr}
            onChange={(e) => setEventDate(e.target.value || todayStr)}
          />
          <p className="text-xs text-surface-400 mt-1">
            The date you physically counted the stock. Cannot be in the future.
          </p>
        </div>
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader /></div>
        ) : !types?.length ? (
          <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50 text-sm">
            No cylinder types yet — add them in <a href="/app/settings?tab=cylinders" className="text-brand-600 dark:text-brand-400 underline">Settings → Cylinder Types</a> first.
          </div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Cylinder type</th><th>Opening fulls</th><th>Opening empties</th></tr></thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.cylinderTypeId}>
                    <td className="font-medium">{t.typeName} <span className="text-xs text-surface-400">({t.capacity}{t.unit})</span></td>
                    <td>
                      <input
                        type="number" min={0} className="input py-1 w-28"
                        value={entries[t.cylinderTypeId]?.fulls ?? ''}
                        onChange={(e) => setVal(t.cylinderTypeId, 'fulls', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="number" min={0} className="input py-1 w-28"
                        value={entries[t.cylinderTypeId]?.empties ?? ''}
                        onChange={(e) => setVal(t.cylinderTypeId, 'empties', e.target.value)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {conflicts && (
          <div className="p-4 rounded-lg border border-amber-400/40 bg-amber-50/50 dark:bg-amber-950/20 space-y-3">
            <div className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              Opening stock has already been entered for these cylinder types:
            </div>
            <ul className="text-sm text-surface-700 dark:text-surface-200 list-disc pl-5 space-y-1">
              {conflicts.map((c) => (
                <li key={c.cylinderTypeId}>
                  <span className="font-medium">{typeName(c.cylinderTypeId)}</span> —{' '}
                  {c.fulls} filled, {c.empties} empty (as of {c.eventDate})
                </li>
              ))}
            </ul>
            <div className="text-sm text-amber-900 dark:text-amber-200">
              Do you want to <strong>REPLACE</strong> the existing values with the new ones? This cannot be undone.
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConflicts(null)}>Cancel</Button>
              <Button onClick={() => submit.mutate(true)} loading={submit.isPending}>Yes, Replace</Button>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => submit.mutate(false)}
            loading={submit.isPending && !conflicts}
            disabled={!types?.length || !!conflicts}
          >Save</Button>
        </div>
      </div>
    </Modal>
  );
}

function useCsvFile<TRow>(map: (r: Record<string, string>) => TRow | null): { rows: TRow[]; rawCount: number; setFile: (f: File | null) => Promise<void>; fileName: string | null } {
  const [rows, setRows] = useState<TRow[]>([]);
  const [rawCount, setRawCount] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);

  const setFile = async (f: File | null) => {
    if (!f) { setRows([]); setRawCount(0); setFileName(null); return; }
    const text = await f.text();
    const parsed = parseCsv(text);
    const mapped = parsed.rows.map(map).filter((r): r is TRow => r != null);
    setRows(mapped);
    setRawCount(parsed.rows.length);
    setFileName(f.name);
  };

  return { rows, rawCount, setFile, fileName };
}

function CustomerImportModal({ onClose }: { onClose: () => void }) {
  // Group 3 (2026-06-11): rich CSV — structured address columns + email
  // + transport charge. Mapper passes the new fields straight through.
  // 2026-06-11 follow-up: also accepts `business_name` for the legal /
  // billing entity name on B2B customers.
  type CRow = {
    name: string; phone: string;
    businessName?: string;
    address?: string; line1?: string; line2?: string; city?: string; state?: string; pincode?: string;
    // Group D2 (2026-06-11): optional shipping address columns.
    shippingLine1?: string; shippingLine2?: string; shippingCity?: string; shippingState?: string; shippingPincode?: string;
    gstin?: string; email?: string; creditPeriodDays?: number; customerType?: string;
    transportChargePerCylinder?: number;
  };
  const csv = useCsvFile<CRow>((r) => {
    if (!r.name && !r.phone) return null;
    const credit = r.credit_period_days?.trim();
    const tc = r.transport_charge?.trim();
    return {
      name: r.name,
      phone: r.phone,
      businessName: r.business_name || undefined,
      address: r.address || undefined,
      line1: r.line1 || undefined,
      line2: r.line2 || undefined,
      city: r.city || undefined,
      state: r.state || undefined,
      pincode: r.pincode || undefined,
      shippingLine1: r.shipping_line1 || undefined,
      shippingLine2: r.shipping_line2 || undefined,
      shippingCity: r.shipping_city || undefined,
      shippingState: r.shipping_state || undefined,
      shippingPincode: r.shipping_pincode || undefined,
      gstin: r.gstin || undefined,
      email: r.email || undefined,
      creditPeriodDays: credit ? Number(credit) : undefined,
      customerType: r.customer_type || undefined,
      transportChargePerCylinder: tc ? Number(tc) : undefined,
    };
  });

  const [importWarnings, setImportWarnings] = useState<Array<{ row: number; name?: string; message: string }>>([]);
  const submit = useMutation({
    mutationFn: () =>
      apiPost<{
        imported: number; created: number; updated: number;
        failures: { row: number; reason: string }[];
        // Group D2 (2026-06-11): soft warnings (row imported but
        // something worth flagging — non-standard state, future E1
        // duplicate-GSTIN signal, etc.).
        warnings: { row: number; name?: string; message: string }[];
      }>('/customers/import-csv', { rows: csv.rows }),
    onSuccess: (r) => {
      const parts: string[] = [];
      if (r.created > 0) parts.push(`${r.created} created`);
      if (r.updated > 0) parts.push(`${r.updated} updated`);
      if (r.failures.length > 0) parts.push(`${r.failures.length} failed`);
      if (r.warnings && r.warnings.length > 0) parts.push(`${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}`);
      const msg = parts.join(' · ') || 'Nothing imported';
      if (r.failures.length > 0) toast(msg, { icon: '⚠️' });
      else if (r.warnings && r.warnings.length > 0) toast(msg, { icon: '⚠️' });
      else toast.success(msg);
      setImportWarnings(r.warnings || []);
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  return (
    <Modal open onClose={onClose} title="Import customers from CSV" size="lg">
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => downloadCsv('customers-template.csv', CUSTOMER_TEMPLATE)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline"
        >
          <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
          </svg>
          Download CSV template
        </button>
        <input type="file" accept=".csv,text/csv" onChange={(e) => csv.setFile(e.target.files?.[0] ?? null)} className="text-sm" />
        <p className="text-xs text-surface-500 dark:text-surface-400">
          Required: <code>name</code>, <code>phone</code>. Optional address can be a single <code>address</code>
          column (auto-parsed into pincode/state/line1) OR separate <code>line1</code>/<code>city</code>/<code>state</code>/<code>pincode</code> columns.
          Optional shipping override (chain stores / commercial sites): <code>shipping_line1</code>/<code>shipping_line2</code>/<code>shipping_city</code>/<code>shipping_state</code>/<code>shipping_pincode</code>.
          Other optional: <code>business_name</code>, <code>gstin</code>, <code>email</code>, <code>credit_period_days</code>, <code>customer_type</code>, <code>transport_charge</code>.
          Re-running the same file UPDATES matched customers without overwriting fields you left blank.
        </p>
        {importWarnings.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200 space-y-1 max-h-40 overflow-auto">
            <p className="font-semibold">{importWarnings.length} row warning{importWarnings.length === 1 ? '' : 's'} — imported, please review:</p>
            {importWarnings.map((w, i) => (
              <p key={i}>Row {w.row}{w.name ? ` (${w.name})` : ''}: {w.message}</p>
            ))}
          </div>
        )}
        {csv.fileName && (
          <p className="text-xs text-surface-500">{csv.fileName} · {csv.rows.length} valid row{csv.rows.length === 1 ? '' : 's'} of {csv.rawCount}</p>
        )}
        {csv.rows.length > 0 && (
          <div className="table-container max-h-64 overflow-auto">
            <table className="table">
              <thead><tr><th>Name</th><th>Phone</th><th>City</th><th>GSTIN</th><th>Credit days</th></tr></thead>
              <tbody>
                {csv.rows.slice(0, 10).map((r, i) => (
                  <tr key={i}><td>{r.name}</td><td>{r.phone}</td><td>{r.city || '-'}</td><td>{r.gstin || '-'}</td><td>{r.creditPeriodDays ?? '-'}</td></tr>
                ))}
              </tbody>
            </table>
            {csv.rows.length > 10 && <p className="text-xs text-surface-400 p-2">… and {csv.rows.length - 10} more</p>}
          </div>
        )}
        {submit.data && (
          <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50 text-sm">
            <p className="font-medium text-surface-900 dark:text-white">
              Created: {submit.data.created} · Updated: {submit.data.updated} · Failed: {submit.data.failures.length}
            </p>
            {submit.data.failures.slice(0, 10).map((f, i) => (
              <p key={i} className="text-xs text-red-500 mt-1">Row {f.row}: {f.reason}</p>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button onClick={() => submit.mutate()} loading={submit.isPending} disabled={csv.rows.length === 0}>Import {csv.rows.length} customer{csv.rows.length === 1 ? '' : 's'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function OpeningBalanceImportModal({ onClose }: { onClose: () => void }) {
  type OBRow = { customerName?: string; phone?: string; openingBalance: number; notes?: string; asOfDate?: string };
  const csv = useCsvFile<OBRow>((r) => {
    const amt = Number(r.opening_balance);
    if (!Number.isFinite(amt)) return null;
    if (!r.customer_name && !r.phone) return null;
    const asOfDate = r.as_of_date && /^\d{4}-\d{2}-\d{2}$/.test(r.as_of_date)
      ? r.as_of_date : undefined;
    return {
      customerName: r.customer_name || undefined,
      phone: r.phone || undefined,
      openingBalance: amt,
      notes: r.notes || undefined,
      asOfDate,
    };
  });

  // Group 3 (2026-06-11): replace-existing toggle. OFF by default — the
  // importer silently skips customers who already have an OB invoice, so
  // re-running the same CSV is safe. ON deletes the prior OB + ledger
  // entry before writing the new one.
  const [replaceExisting, setReplaceExisting] = useState(false);

  const submit = useMutation({
    mutationFn: () =>
      apiPost<{
        imported: number;
        skipped: number;
        skippedCustomers: string[];
        failures: { row: number; reason: string }[];
      }>('/customers/import-opening-balances', { rows: csv.rows, replaceExisting }),
    onSuccess: (r) => {
      const parts: string[] = [];
      if (r.imported > 0) parts.push(`${replaceExisting ? 'Replaced/imported' : 'Imported'} ${r.imported}`);
      if (r.skipped > 0) parts.push(`skipped ${r.skipped}`);
      if (r.failures.length > 0) parts.push(`${r.failures.length} failed`);
      const msg = parts.join(' · ') || 'Nothing imported';
      if (r.failures.length > 0 || r.skipped > 0) toast(msg, { icon: '⚠️' });
      else toast.success(msg);
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  return (
    <Modal open onClose={onClose} title="Import opening balances from CSV" size="lg">
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => downloadCsv('opening-balances-template.csv', OPENING_BAL_TEMPLATE)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline"
        >
          <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
          </svg>
          Download CSV template
        </button>
        <input type="file" accept=".csv,text/csv" onChange={(e) => csv.setFile(e.target.files?.[0] ?? null)} className="text-sm" />
        <p className="text-xs text-surface-500 dark:text-surface-400">
          Required: <code>customer_name</code> OR <code>phone</code>, plus <code>opening_balance</code>.
          Optional: <code>as_of_date</code> (YYYY-MM-DD), <code>notes</code>.
          Re-running the same file is safe — customers who already have an opening balance are skipped unless you tick Replace existing.
        </p>
        {csv.fileName && (
          <p className="text-xs text-surface-500">{csv.fileName} · {csv.rows.length} valid row{csv.rows.length === 1 ? '' : 's'} of {csv.rawCount}</p>
        )}
        {csv.rows.length > 0 && (
          <div className="table-container max-h-64 overflow-auto">
            <table className="table">
              <thead><tr><th>Customer</th><th>Phone</th><th>Opening balance</th><th>As of</th><th>Notes</th></tr></thead>
              <tbody>
                {csv.rows.slice(0, 10).map((r, i) => (
                  <tr key={i}>
                    <td>{r.customerName ?? '-'}</td>
                    <td>{r.phone ?? '-'}</td>
                    <td>₹{r.openingBalance.toLocaleString('en-IN')}</td>
                    <td className="text-xs">{r.asOfDate ?? '-'}</td>
                    <td className="text-xs">{r.notes ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {csv.rows.length > 10 && <p className="text-xs text-surface-400 p-2">… and {csv.rows.length - 10} more</p>}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-300">
          <input type="checkbox" checked={replaceExisting} onChange={(e) => setReplaceExisting(e.target.checked)} />
          <span>Replace existing opening balances (use only when correcting a previous import)</span>
        </label>
        {submit.data && (
          <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50 text-sm space-y-1">
            <p className="font-medium text-surface-900 dark:text-white">
              Imported: {submit.data.imported} · Skipped: {submit.data.skipped} · Failed: {submit.data.failures.length}
            </p>
            {submit.data.skippedCustomers.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Already had opening balances (skipped): {submit.data.skippedCustomers.slice(0, 8).join(', ')}
                {submit.data.skippedCustomers.length > 8 && ` and ${submit.data.skippedCustomers.length - 8} more`}
              </p>
            )}
            {submit.data.failures.slice(0, 10).map((f, i) => (
              <p key={i} className="text-xs text-red-500">Row {f.row}: {f.reason}</p>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button onClick={() => submit.mutate()} loading={submit.isPending} disabled={csv.rows.length === 0}>Import {csv.rows.length} balance{csv.rows.length === 1 ? '' : 's'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function EmptyBalanceImportModal({ onClose }: { onClose: () => void }) {
  // Group 4 (2026-06-11): per-customer empty cylinder opening counts.
  type ERow = { customerName?: string; phone?: string; cylinderType: string; emptyQuantity: number };
  const csv = useCsvFile<ERow>((r) => {
    if (!r.cylinder_type || !r.empty_quantity) return null;
    if (!r.customer_name && !r.phone) return null;
    const qty = Number(r.empty_quantity);
    if (!Number.isFinite(qty) || qty < 0) return null;
    return {
      customerName: r.customer_name || undefined,
      phone: r.phone || undefined,
      cylinderType: r.cylinder_type,
      emptyQuantity: Math.floor(qty),
    };
  });

  const submit = useMutation({
    mutationFn: () => apiPost<{
      imported: number; updated: number;
      failures: { row: number; reason: string }[];
    }>('/customers/import-empty-balances', { rows: csv.rows }),
    onSuccess: (r) => {
      const parts: string[] = [];
      if (r.imported > 0) parts.push(`${r.imported} created`);
      if (r.updated > 0) parts.push(`${r.updated} updated`);
      if (r.failures.length > 0) parts.push(`${r.failures.length} failed`);
      const msg = parts.join(' · ') || 'Nothing imported';
      if (r.failures.length > 0) toast(msg, { icon: '⚠️' });
      else toast.success(msg);
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  return (
    <Modal open onClose={onClose} title="Import empty cylinders held by customers" size="lg">
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => downloadCsv('empty-balances-template.csv', EMPTY_BAL_TEMPLATE)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline"
        >
          <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
          </svg>
          Download CSV template
        </button>
        <input type="file" accept=".csv,text/csv" onChange={(e) => csv.setFile(e.target.files?.[0] ?? null)} className="text-sm" />
        <p className="text-xs text-surface-500 dark:text-surface-400">
          Required: <code>customer_name</code> OR <code>phone</code>, plus <code>cylinder_type</code> (must match an existing type for your distributor, e.g. &quot;19 KG&quot;) and <code>empty_quantity</code> (non-negative integer).
          Re-running the same file updates the count in place — safe to run multiple times.
        </p>
        {csv.fileName && (
          <p className="text-xs text-surface-500">{csv.fileName} · {csv.rows.length} valid row{csv.rows.length === 1 ? '' : 's'} of {csv.rawCount}</p>
        )}
        {csv.rows.length > 0 && (
          <div className="table-container max-h-64 overflow-auto">
            <table className="table">
              <thead><tr><th>Customer</th><th>Phone</th><th>Cylinder type</th><th>Empties</th></tr></thead>
              <tbody>
                {csv.rows.slice(0, 10).map((r, i) => (
                  <tr key={i}>
                    <td>{r.customerName ?? '-'}</td>
                    <td>{r.phone ?? '-'}</td>
                    <td>{r.cylinderType}</td>
                    <td>{r.emptyQuantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {csv.rows.length > 10 && <p className="text-xs text-surface-400 p-2">… and {csv.rows.length - 10} more</p>}
          </div>
        )}
        {submit.data && (
          <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50 text-sm">
            <p className="font-medium text-surface-900 dark:text-white">
              Created: {submit.data.imported} · Updated: {submit.data.updated} · Failed: {submit.data.failures.length}
            </p>
            {submit.data.failures.slice(0, 10).map((f, i) => (
              <p key={i} className="text-xs text-red-500 mt-1">Row {f.row}: {f.reason}</p>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button onClick={() => submit.mutate()} loading={submit.isPending} disabled={csv.rows.length === 0}>Import {csv.rows.length} row{csv.rows.length === 1 ? '' : 's'}</Button>
        </div>
      </div>
    </Modal>
  );
}
