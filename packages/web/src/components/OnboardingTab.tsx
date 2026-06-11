import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Button, Loader, Modal } from '@/components/ui';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { useAuthStore, selectDistributorId } from '@/stores/authStore';

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

const CUSTOMER_TEMPLATE = 'name,phone,address,gstin,credit_period_days,customer_type\n' +
  'Royal Kitchen Restaurant,9876543210,"123 Main Street, Hyderabad",36AABCU9603R1ZX,30,commercial\n' +
  'Green Valley Home,9876543211,"456 Colony Road, Hyderabad",,0,domestic\n';
const OPENING_BAL_TEMPLATE = 'customer_name,opening_balance,notes\n' +
  'Royal Kitchen Restaurant,15000,Outstanding as of today\n' +
  'Green Valley Home,2500,\n';

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

  const [importer, setImporter] = useState<'customers' | 'opening-balances' | null>(null);
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
            // Steps that have a dedicated modal on this very tab open it
            // directly instead of navigating — otherwise the step's link
            // ('/app/settings?tab=onboarding') just reloads this same page
            // and the click feels dead.
            const isStock = s.key === 'opening_stock';
            const isOpeningBalances = s.key === 'opening_balances';
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
            if (isStock) {
              return <button key={s.key} type="button" onClick={() => setOpeningStockOpen(true)} className={className}>{inner}</button>;
            }
            if (isOpeningBalances) {
              return <button key={s.key} type="button" onClick={() => setImporter('opening-balances')} className={className}>{inner}</button>;
            }
            return <a key={s.key} href={s.link} className={className}>{inner}</a>;
          })}
        </div>
      </div>

      <div className="card p-5">
        <h3 className="font-semibold text-surface-900 dark:text-white mb-4">Bulk import</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="p-4 rounded-xl border border-surface-200 dark:border-surface-700">
            <p className="font-medium text-surface-900 dark:text-white">Import customers</p>
            <p className="text-xs text-surface-500 mt-1">CSV with columns: name, phone, address, gstin, credit_period_days, customer_type</p>
            <div className="flex gap-2 mt-3">
              <Button variant="ghost" size="sm" onClick={() => downloadCsv('customers-template.csv', CUSTOMER_TEMPLATE)}>Download template</Button>
              <Button size="sm" onClick={() => setImporter('customers')}>Upload CSV</Button>
            </div>
          </div>
          <div className="p-4 rounded-xl border border-surface-200 dark:border-surface-700">
            <p className="font-medium text-surface-900 dark:text-white">Import opening balances</p>
            <p className="text-xs text-surface-500 mt-1">CSV with columns: customer_name, phone, opening_balance, notes</p>
            <div className="flex gap-2 mt-3">
              <Button variant="ghost" size="sm" onClick={() => downloadCsv('opening-balances-template.csv', OPENING_BAL_TEMPLATE)}>Download template</Button>
              <Button size="sm" onClick={() => setImporter('opening-balances')}>Upload CSV</Button>
            </div>
          </div>
        </div>
      </div>

      {importer === 'customers' && <CustomerImportModal onClose={() => { setImporter(null); qc.invalidateQueries({ queryKey: ['onboarding-progress'] }); }} />}
      {importer === 'opening-balances' && <OpeningBalanceImportModal onClose={() => { setImporter(null); qc.invalidateQueries({ queryKey: ['onboarding-progress'] }); }} />}
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
  const csv = useCsvFile<{ name: string; phone: string; address?: string; gstin?: string; creditPeriodDays?: number; customerType?: string }>((r) => {
    if (!r.name && !r.phone) return null;
    const credit = r.credit_period_days?.trim();
    return {
      name: r.name,
      phone: r.phone,
      address: r.address || undefined,
      gstin: r.gstin || undefined,
      creditPeriodDays: credit ? Number(credit) : undefined,
      customerType: r.customer_type || undefined,
    };
  });

  const submit = useMutation({
    mutationFn: () => apiPost<{ imported: number; failures: { row: number; reason: string }[] }>('/customers/import-csv', { rows: csv.rows }),
    onSuccess: (r) => {
      if (r.failures.length === 0) toast.success(`Imported ${r.imported} customers`);
      else toast(`Imported ${r.imported} · ${r.failures.length} failed`, { icon: '⚠️' });
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
          Required columns: name, phone. Optional: address, gstin, credit_period_days, customer_type
        </p>
        {csv.fileName && (
          <p className="text-xs text-surface-500">{csv.fileName} · {csv.rows.length} valid row{csv.rows.length === 1 ? '' : 's'} of {csv.rawCount}</p>
        )}
        {csv.rows.length > 0 && (
          <div className="table-container max-h-64 overflow-auto">
            <table className="table">
              <thead><tr><th>Name</th><th>Phone</th><th>GSTIN</th><th>Credit days</th></tr></thead>
              <tbody>
                {csv.rows.slice(0, 10).map((r, i) => (
                  <tr key={i}><td>{r.name}</td><td>{r.phone}</td><td>{r.gstin || '-'}</td><td>{r.creditPeriodDays ?? '-'}</td></tr>
                ))}
              </tbody>
            </table>
            {csv.rows.length > 10 && <p className="text-xs text-surface-400 p-2">… and {csv.rows.length - 10} more</p>}
          </div>
        )}
        {submit.data && (
          <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50 text-sm">
            <p className="font-medium text-surface-900 dark:text-white">Imported: {submit.data.imported} · Failed: {submit.data.failures.length}</p>
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
  const csv = useCsvFile<{ customerName?: string; phone?: string; openingBalance: number; notes?: string }>((r) => {
    const amt = Number(r.opening_balance);
    if (!Number.isFinite(amt)) return null;
    if (!r.customer_name && !r.phone) return null;
    return {
      customerName: r.customer_name || undefined,
      phone: r.phone || undefined,
      openingBalance: amt,
      notes: r.notes || undefined,
    };
  });

  const submit = useMutation({
    mutationFn: () => apiPost<{ imported: number; failures: { row: number; reason: string }[] }>('/customers/import-opening-balances', { rows: csv.rows }),
    onSuccess: (r) => {
      if (r.failures.length === 0) toast.success(`Imported ${r.imported} opening balances`);
      else toast(`Imported ${r.imported} · ${r.failures.length} failed`, { icon: '⚠️' });
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
          Required columns: customer_name, opening_balance. Customer name must match exactly as entered in system.
        </p>
        {csv.fileName && (
          <p className="text-xs text-surface-500">{csv.fileName} · {csv.rows.length} valid row{csv.rows.length === 1 ? '' : 's'} of {csv.rawCount}</p>
        )}
        {csv.rows.length > 0 && (
          <div className="table-container max-h-64 overflow-auto">
            <table className="table">
              <thead><tr><th>Customer</th><th>Phone</th><th>Opening balance</th><th>Notes</th></tr></thead>
              <tbody>
                {csv.rows.slice(0, 10).map((r, i) => (
                  <tr key={i}><td>{r.customerName ?? '-'}</td><td>{r.phone ?? '-'}</td><td>₹{r.openingBalance.toLocaleString('en-IN')}</td><td className="text-xs">{r.notes ?? '-'}</td></tr>
                ))}
              </tbody>
            </table>
            {csv.rows.length > 10 && <p className="text-xs text-surface-400 p-2">… and {csv.rows.length - 10} more</p>}
          </div>
        )}
        {submit.data && (
          <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50 text-sm">
            <p className="font-medium text-surface-900 dark:text-white">Imported: {submit.data.imported} · Failed: {submit.data.failures.length}</p>
            {submit.data.failures.slice(0, 10).map((f, i) => (
              <p key={i} className="text-xs text-red-500 mt-1">Row {f.row}: {f.reason}</p>
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
