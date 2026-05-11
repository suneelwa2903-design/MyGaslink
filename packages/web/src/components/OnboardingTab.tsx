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

const CUSTOMER_TEMPLATE = 'name,phone,address,gstin,credit_period_days,customer_type\nRoyal Kitchen,9876543210,123 MG Road Bangalore,29ABCDE1234F1Z5,30,B2B\n';
const OPENING_BAL_TEMPLATE = 'customer_name,phone,opening_balance,notes\nRoyal Kitchen,9876543210,12500,Carried forward from old system\n';

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
            const isStock = s.key === 'opening_stock';
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
            return isStock ? (
              <button key={s.key} type="button" onClick={() => setOpeningStockOpen(true)} className={className}>{inner}</button>
            ) : (
              <a key={s.key} href={s.link} className={className}>{inner}</a>
            );
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

  const setVal = (id: string, field: 'fulls' | 'empties', v: string) => {
    setEntries((prev) => ({ ...prev, [id]: { fulls: prev[id]?.fulls ?? '', empties: prev[id]?.empties ?? '', [field]: v } }));
  };

  const submit = useMutation({
    mutationFn: () => {
      const payload = (types ?? [])
        .map((t) => {
          const e = entries[t.cylinderTypeId];
          const fulls = Number(e?.fulls ?? '0') || 0;
          const empties = Number(e?.empties ?? '0') || 0;
          return { cylinderTypeId: t.cylinderTypeId, openingFulls: fulls, openingEmpties: empties };
        })
        .filter((e) => e.openingFulls > 0 || e.openingEmpties > 0);
      if (payload.length === 0) throw new Error('Enter at least one opening balance');
      return apiPost<{ created: number }>('/inventory/initial-balance', { entries: payload });
    },
    onSuccess: (r) => {
      toast.success(`Opening stock saved (${r.created} cylinder type${r.created === 1 ? '' : 's'})`);
      onClose();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  return (
    <Modal open onClose={onClose} title="Enter Opening Stock" size="lg">
      <div className="space-y-4">
        <p className="text-sm text-surface-500">Enter your stock count as of yesterday. Leave a row at zero to skip it.</p>
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
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => submit.mutate()} loading={submit.isPending} disabled={!types?.length}>Save</Button>
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
        <input type="file" accept=".csv,text/csv" onChange={(e) => csv.setFile(e.target.files?.[0] ?? null)} className="text-sm" />
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
        <input type="file" accept=".csv,text/csv" onChange={(e) => csv.setFile(e.target.files?.[0] ?? null)} className="text-sm" />
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
