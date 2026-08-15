/**
 * F8 v2 Corporation Ledger Page (2026-08-06)
 *
 * Regular-distributor Purchases redesign. One page per corporation:
 *   • Header + 4 summary chips (Outstanding / Deposit / Avg Landed / Last activity)
 *   • Filter bar (date range + entry-type)
 *   • Money-first account ledger table (matches Confidence PDF format)
 *   • "+ Add Entry" dropdown — Incoming Fulls / Outgoing Empties / Payment /
 *     Credit Note / Debit Note / Deposit (v2-4 wires the modals)
 *   • Physical Activity + Landed Cost + Deposit panels (v2-7 fills them)
 *   • Statement PDF download (Confidence portrait A4 — from F8 v1)
 *
 * This page replaces the mini-op-parity 2-tab Purchases surface for regular
 * distributor tenants. Mini-op tenants keep the existing PurchasesPage.tsx.
 */
import { Fragment, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HiOutlineArrowDownTray, HiOutlineChevronDown } from 'react-icons/hi2';
import { api, apiGet, getErrorMessage } from '@/lib/api';
import { Button, Loader, Select } from '@/components/ui';
import toast from 'react-hot-toast';
import { localTodayISO } from '@gaslink/shared';
import {
  DepositInvoiceModal,
  PaymentModal,
  CreditNoteModal,
  DebitNoteModal,
} from '@/components/corporations/CorpEntryModals';
// F8v2-FIX-A (2026-08-06) — Corp Ledger reuses the EXACT same Incoming/
// Outgoing modals that Inventory page uses. No duplicate modals; no
// navigate-away. Same UX from both surfaces.
import { IncomingFullsModal, OutgoingEmptiesModal } from '@/pages/InventoryPage';

// ─── Wire types (mirror service outputs) ────────────────────────────────────

interface SupplierBalance {
  sourceDistributorId: string;
  name: string;
  totalPurchased: number;
  totalPaid: number;
  totalCreditNotes: number;
  totalDebitNotes: number;
  totalDeposits: number;
  outstanding: number;
  lastPurchaseDate: string | null;
  lastPaymentDate: string | null;
}

interface LedgerRow {
  entryDate: string;
  kind:
    | 'purchase'
    | 'payment'
    | 'credit_note'
    | 'debit_note'
    | 'deposit'
    | 'erv_empties'
    | 'erv_defective';
  documentId: string;
  documentNumber: string | null;
  supplierDocumentNumber?: string | null;
  narration: string;
  debit: number;
  credit: number;
  balance: number;
  physicalQty?: number;
  cylinderTypeName?: string;
  plantName?: string | null;
}

interface LedgerResponse {
  source: { id: string; name: string };
  rows: LedgerRow[];
  summary: {
    totalPurchased: number;
    totalPaid: number;
    totalCreditNotes: number;
    totalDebitNotes: number;
    totalDeposits: number;
    netOutstanding: number;
  };
  filters: { from: string | null; to: string | null };
}

interface AvgLandedCost {
  avgPerCyl: number;
  totalCyls: number;
  windowDays: number;
}

// ─── Small helpers ─────────────────────────────────────────────────────────

// F8v2-FIX (2026-08-06) — plain-language kind labels. Suneel: use "Incoming"
// / "Outgoing" instead of the internal ERV enum name. The distinction
// between empties + defective is preserved as a suffix so the operator can
// spot defective returns at a glance.
const KIND_LABELS: Record<LedgerRow['kind'], string> = {
  purchase: 'INCOMING',
  payment: 'PAYMENT',
  credit_note: 'CREDIT NOTE',
  debit_note: 'DEBIT NOTE',
  deposit: 'DEPOSIT',
  erv_empties: 'OUTGOING (EMPTIES)',
  erv_defective: 'OUTGOING (DEFECTIVE)',
};

function fmtMoney(n: number, showZero = false): string {
  if (!showZero && !n) return '—';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
// F8 v2 (2026-08-06) — Dr/Cr labels follow the OMC-side Confidence-PDF
// convention Suneel shared: distributor owes OMC → Dr (they're the
// debtor from OMC's book). Distributor has credit position → Cr. This
// is what the physical statement from IOCL/HPCL/GoGas prints, so our
// on-screen ledger + downloaded statement PDF match by-eye reconciliation.
function drCr(balance: number): 'Dr' | 'Cr' {
  return balance > 0.005 ? 'Dr' : 'Cr';
}

// ─── Page component ────────────────────────────────────────────────────────

export default function CorporationLedgerPage() {
  const { corpId: routeCorpId } = useParams<{ corpId: string }>();
  const navigate = useNavigate();

  // Fallback: if no :corpId in URL (sidebar landing on single-OMC tenant),
  // resolve from the tenant's supplier list — pick the first.
  const { data: balances = [], isLoading: balancesLoading } = useQuery<SupplierBalance[]>({
    queryKey: ['supplier-balances-v2'],
    queryFn: async () => {
      const res = await apiGet<{ suppliers: SupplierBalance[] }>('/purchase-payments/supplier-balances');
      return res.suppliers ?? [];
    },
  });

  const activeCorpId = routeCorpId ?? balances[0]?.sourceDistributorId ?? '';
  const activeBalance = balances.find((b) => b.sourceDistributorId === activeCorpId);

  // F8v2-FIX-A (2026-08-06) — cyl types / vehicles / drivers needed by the
  // shared Inventory Incoming Fulls + Outgoing Empties modals. Fetched
  // here at the corp-page level so the modals get real data (they used
  // to be Inventory-only + relied on that page's queries).
  const { data: cylTypesResp } = useQuery({
    queryKey: ['cylinder-types-v2'],
    queryFn: async () => {
      const res = await apiGet<{ cylinderTypes?: unknown[] } | unknown[]>('/cylinder-types');
      return Array.isArray(res) ? res : (res?.cylinderTypes ?? []);
    },
  });
  const cylTypesList = Array.isArray(cylTypesResp) ? cylTypesResp : [];
  const { data: vehiclesResp } = useQuery({
    queryKey: ['vehicles-all-corp'],
    queryFn: async () => {
      // 2026-08-15 — list ALL vehicles from Transport (no status filter). The
      // previous `status: 'idle,dispatched,returned,reconciled'` comma-list was
      // shoved whole into a single VehicleStatus enum by listVehicles and made
      // Prisma throw "Invalid value for argument status" — so the vehicle
      // dropdown was always empty on Corp. Loads. A corporation supply can be
      // received against any vehicle regardless of its current trip state, so
      // no filter is the correct behaviour (mirrors the Godown incoming modal).
      const res = await apiGet<{ vehicles?: unknown[] } | unknown[]>('/vehicles');
      return Array.isArray(res) ? res : (res?.vehicles ?? []);
    },
  });
  const vehiclesList = Array.isArray(vehiclesResp) ? vehiclesResp : [];
  const { data: driversResp } = useQuery({
    queryKey: ['drivers-active-corp'],
    queryFn: async () => {
      const res = await apiGet<{ drivers?: unknown[] } | unknown[]>('/drivers', { status: 'active' });
      return Array.isArray(res) ? res : (res?.drivers ?? []);
    },
  });
  const driversList = Array.isArray(driversResp) ? driversResp : [];

  // Add-Entry modal state — one of the 6 entry types or null.
  const [entryOpen, setEntryOpen] = useState<
    null | 'incoming_fulls' | 'outgoing_empties' | 'payment' | 'credit_note' | 'debit_note' | 'deposit'
  >(null);
  const queryClient = useQueryClient();
  const onModalSaved = () => {
    // Invalidate every query the ledger + summary chips depend on.
    queryClient.invalidateQueries({ queryKey: ['supplier-balances-v2'] });
    queryClient.invalidateQueries({ queryKey: ['corp-ledger', activeCorpId] });
    queryClient.invalidateQueries({ queryKey: ['corp-avg-landed', activeCorpId] });
    queryClient.invalidateQueries({ queryKey: ['corp-landed-cost', activeCorpId] });
    queryClient.invalidateQueries({ queryKey: ['purchase-outstanding', activeCorpId] });
    // 2026-08-15 — the FIFO "Cost Layer Ledger — open loads" panel reads
    // ['corp-cost-layers'] (see the useQuery at ~L690). It was NOT invalidated
    // here, so a just-recorded incoming appeared in the ledger + per-month
    // landed table but its FIFO open-load stayed missing until a hard refresh.
    queryClient.invalidateQueries({ queryKey: ['corp-cost-layers'] });
    // Cross-page reflect: Inventory Depot History reads the same events.
    queryClient.invalidateQueries({ queryKey: ['inventory'] });
    queryClient.invalidateQueries({ queryKey: ['depot-history'] });
    setEntryOpen(null);
  };

  const showCorpPicker = balances.length > 1;

  // Date range filter — default: current financial year to date.
  // (FY starts Apr 1 in India — see numberingService.getFinancialYear.)
  const [from, setFrom] = useState(() => {
    const now = new Date();
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return `${y}-04-01`;
  });
  const [to, setTo] = useState(() => localTodayISO());
  const [typeFilter, setTypeFilter] = useState<'all' | LedgerRow['kind']>('all');

  const { data: ledger, isLoading: ledgerLoading } = useQuery<LedgerResponse>({
    queryKey: ['corp-ledger', activeCorpId, from, to],
    queryFn: () =>
      apiGet<LedgerResponse>(`/purchase-payments/supplier-ledger/${activeCorpId}`, { from, to }),
    enabled: Boolean(activeCorpId),
  });

  const { data: avgLanded } = useQuery<AvgLandedCost>({
    queryKey: ['corp-avg-landed', activeCorpId],
    queryFn: () =>
      apiGet<AvgLandedCost>(`/purchase-payments/landed-cost/avg/${activeCorpId}`, { days: 30 }),
    enabled: Boolean(activeCorpId),
  });

  const filteredRows = useMemo(() => {
    if (!ledger) return [];
    if (typeFilter === 'all') return ledger.rows;
    return ledger.rows.filter((r) => r.kind === typeFilter);
  }, [ledger, typeFilter]);

  async function downloadStatementPdf() {
    if (!activeCorpId) return;
    try {
      const res = await api.get(
        `/purchase-payments/supplier-ledger/${activeCorpId}/statement.pdf`,
        { params: { from, to }, responseType: 'blob' },
      );
      const blob = new Blob([res.data as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeBalance?.name ?? 'corporation'}-statement-${from}-to-${to}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  if (balancesLoading) return <Loader />;

  if (balances.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Corp. Loads</h1>
        <p className="mt-4 rounded-md bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-800">
          No corporations set up for this tenant. A super-admin needs to add provider codes
          (IOCL / HPCL / BPCL / GOGAS / etc.) to your distributor profile — they auto-create as
          Corporations here on first save.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header + corp picker (only when multi-OMC) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {showCorpPicker ? (
            <Select
              className="text-lg font-semibold"
              value={activeCorpId}
              options={balances.map((b) => ({ value: b.sourceDistributorId, label: b.name }))}
              onChange={(e) => navigate(`/app/corporations/${e.target.value}`)}
            />
          ) : (
            <h1 className="text-2xl font-semibold">{activeBalance?.name ?? 'Corporation'}</h1>
          )}
          <p className="text-sm text-slate-500 dark:text-surface-400">
            Account ledger — every purchase, payment, credit note, debit note, deposit, and ERV in one place.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={downloadStatementPdf}>
            <HiOutlineArrowDownTray className="mr-1 inline" /> Statement PDF
          </Button>
          <AddEntryButton onPick={(kind) => setEntryOpen(kind)} />
        </div>
      </div>

      {/* Summary chips */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryChip
          label="Outstanding"
          value={fmtMoney(activeBalance?.outstanding ?? 0, true)}
          hint={activeBalance && activeBalance.outstanding > 0.005 ? 'You owe' : 'Settled'}
          tone={activeBalance && activeBalance.outstanding > 0.005 ? 'warn' : 'ok'}
        />
        <SummaryChip
          label="Deposit Balance"
          value={fmtMoney(activeBalance?.totalDeposits ?? 0, true)}
          hint="Refundable cylinder fee"
          tone="neutral"
        />
        <SummaryChip
          label="Avg Landed / Cyl"
          value={fmtMoney(avgLanded?.avgPerCyl ?? 0, true)}
          hint={`Last ${avgLanded?.windowDays ?? 30}d · ${avgLanded?.totalCyls ?? 0} cyls`}
          tone="neutral"
        />
        <SummaryChip
          label="Last Activity"
          value={activeBalance?.lastPurchaseDate ?? '—'}
          hint="Latest purchase"
          tone="neutral"
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 dark:border-surface-700 bg-slate-50 dark:bg-surface-800 p-3">
        <label className="text-sm">
          <div className="text-slate-600 dark:text-surface-300">From</div>
          <input
            type="date"
            className="rounded border border-slate-300 px-2 py-1"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <div className="text-slate-600 dark:text-surface-300">To</div>
          <input
            type="date"
            className="rounded border border-slate-300 px-2 py-1"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <div className="text-slate-600 dark:text-surface-300">Entry type</div>
          <Select
            className="w-48"
            value={typeFilter}
            options={[
              { value: 'all', label: 'All entries' },
              { value: 'purchase', label: 'Incoming (invoice)' },
              { value: 'payment', label: 'Payment' },
              { value: 'credit_note', label: 'Credit Note' },
              { value: 'debit_note', label: 'Debit Note' },
              { value: 'deposit', label: 'Deposit' },
              { value: 'erv_empties', label: 'Outgoing (empties)' },
              { value: 'erv_defective', label: 'Outgoing (defective)' },
            ]}
            onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
          />
        </label>
      </div>

      {/* Ledger table — Confidence-style */}
      <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-surface-700">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 dark:bg-surface-700 text-xs uppercase text-slate-700 dark:text-surface-200">
            <tr>
              <th className="p-2 text-left">Date</th>
              <th className="p-2 text-left">Type</th>
              <th className="p-2 text-left">Doc No</th>
              <th className="p-2 text-left">Narration</th>
              <th className="p-2 text-right">Qty</th>
              <th className="p-2 text-right">Debit</th>
              <th className="p-2 text-right">Credit</th>
              <th className="p-2 text-right">Balance</th>
              <th className="p-2 text-center">Dr/Cr</th>
            </tr>
          </thead>
          <tbody>
            {ledgerLoading ? (
              <tr>
                <td colSpan={9} className="p-6 text-center text-slate-500 dark:text-surface-400">
                  Loading ledger…
                </td>
              </tr>
            ) : filteredRows.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-6 text-center text-slate-500 dark:text-surface-400">
                  No entries in the selected period. Click <b>+ Add Entry</b> to record one.
                </td>
              </tr>
            ) : (
              filteredRows.map((row, i) => (
                <tr
                  key={row.documentId + row.kind}
                  className={i % 2 ? 'bg-slate-50 dark:bg-surface-800' : ''}
                >
                  <td className="p-2 whitespace-nowrap">{row.entryDate}</td>
                  <td className="p-2 whitespace-nowrap">
                    <span className="text-xs font-medium">{KIND_LABELS[row.kind]}</span>
                  </td>
                  <td className="p-2 whitespace-nowrap font-mono text-xs">
                    {row.supplierDocumentNumber ?? row.documentNumber ?? '—'}
                  </td>
                  <td className="p-2 text-slate-700 dark:text-surface-200">{row.narration}</td>
                  <td className="p-2 text-right tabular-nums">{row.physicalQty ? row.physicalQty : '—'}</td>
                  <td className="p-2 text-right">{fmtMoney(row.debit)}</td>
                  <td className="p-2 text-right">{fmtMoney(row.credit)}</td>
                  <td className="p-2 text-right">{fmtMoney(row.balance, true)}</td>
                  <td className="p-2 text-center text-xs font-medium">{drCr(row.balance)}</td>
                </tr>
              ))
            )}
          </tbody>
          {ledger && filteredRows.length > 0 && (
            <tfoot className="bg-slate-100 dark:bg-surface-700 text-sm font-semibold">
              <tr>
                <td colSpan={4} className="p-2 text-right">
                  Totals
                </td>
                {/* No Qty total — mixing incoming + outgoing quantities is
                    meaningless (Suneel 2026-08-15). */}
                <td className="p-2 text-right text-slate-400">—</td>
                <td className="p-2 text-right">
                  {fmtMoney(filteredRows.reduce((s, r) => s + r.debit, 0), true)}
                </td>
                <td className="p-2 text-right">
                  {fmtMoney(filteredRows.reduce((s, r) => s + r.credit, 0), true)}
                </td>
                <td className="p-2 text-right">
                  {fmtMoney(ledger.summary.netOutstanding, true)}
                </td>
                <td className="p-2 text-center">{drCr(ledger.summary.netOutstanding)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Physical Activity panel removed 2026-08-15 — it was a filtered view of
          the same ledger rows; the Qty column above now carries the quantities. */}

      {/* Cost Layer Ledger — merged: per-load FIFO (open + consumed) grouped by
          cyl type → month, with month subtotals, MRP, and dealer margin. */}
      <CostLayerLedgerPanel />

      {/* Deposit Ledger — deposit invoices as a mini-ledger */}
      <DepositLedgerPanel rows={filteredRows} totalDeposits={activeBalance?.totalDeposits ?? 0} />

      {/* ─── Add-Entry modals ──────────────────────────────────────────────
          F8v2-FIX-A: Incoming Fulls + Outgoing Empties use the SAME modal
          components as Inventory page — single source of truth, same UX
          from both surfaces. onSaved fires our invalidator so summary chips
          + ledger refresh in place. */}
      {activeBalance && entryOpen === 'incoming_fulls' && (
        <IncomingFullsModal
          open
          onClose={onModalSaved}
          cylinderTypes={cylTypesList as never}
          vehicles={vehiclesList as never}
          drivers={driversList as never}
          date={localTodayISO()}
        />
      )}
      {activeBalance && entryOpen === 'outgoing_empties' && (
        <OutgoingEmptiesModal
          open
          onClose={onModalSaved}
          cylinderTypes={cylTypesList as never}
          vehicles={vehiclesList as never}
          drivers={driversList as never}
          date={localTodayISO()}
        />
      )}
      {activeBalance && entryOpen === 'deposit' && (
        <DepositInvoiceModal
          corp={{ sourceDistributorId: activeCorpId, name: activeBalance.name }}
          onClose={() => setEntryOpen(null)}
          onSaved={onModalSaved}
        />
      )}
      {activeBalance && entryOpen === 'payment' && (
        <PaymentModal
          corp={{ sourceDistributorId: activeCorpId, name: activeBalance.name }}
          onClose={() => setEntryOpen(null)}
          onSaved={onModalSaved}
        />
      )}
      {activeBalance && entryOpen === 'credit_note' && (
        <CreditNoteModal
          corp={{ sourceDistributorId: activeCorpId, name: activeBalance.name }}
          onClose={() => setEntryOpen(null)}
          onSaved={onModalSaved}
        />
      )}
      {activeBalance && entryOpen === 'debit_note' && (
        <DebitNoteModal
          corp={{ sourceDistributorId: activeCorpId, name: activeBalance.name }}
          onClose={() => setEntryOpen(null)}
          onSaved={onModalSaved}
        />
      )}
      {/* Outgoing Empties opens Inventory's existing modal via query param —
          reuses F1's include-defectives flow, no duplication here. */}
    </div>
  );
}

// ─── Below-ledger panels ───────────────────────────────────────────────────


// ─── Cost Layer Ledger (merged, 2026-08-15) ─────────────────────────────────
// ONE table replacing the old "Landed Cost per month" + "Cost Layer FIFO" pair.
// Per-load rows grouped by cyl type → month, with a month-average subtotal
// (Line/Freight/CN/DN breakdown) and the dealer margin = MRP − landed (MRP from
// the Settings selling price). All GST-INCLUSIVE.
interface CostLedgerRow {
  cylinderTypeId: string;
  cylinderTypeName: string;
  date: string;
  ref: string;
  purchaseEntryId: string | null;
  qtyReceived: number;
  qtyRemaining: number;
  grossRate: number;
  freightPerCyl: number;
  cnPerCyl: number;
  dnPerCyl: number;
  landedRate: number;
  mrp: number; // MRP effective on THIS load's date (date-effective, GST-incl)
}
interface CostLedgerResponse {
  gstMode: 'live' | 'sandbox' | 'disabled';
  rows: CostLedgerRow[];
  mrpByType: Record<string, number>;
  totalRemainingQty: number;
  totalValue: number;
}

function CostLayerLedgerPanel() {
  const { data, isLoading } = useQuery<CostLedgerResponse>({
    // Key unchanged so onModalSaved's invalidation still refreshes this panel.
    queryKey: ['corp-cost-layers'],
    queryFn: () => apiGet<CostLedgerResponse>('/purchase-payments/cost-ledger'),
  });
  // Collapse state per cyl type. Collapsed → only the type header (which shows
  // the type-level summary) is visible; expanded → per-load rows + month subtotals.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (name: string) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name); else n.add(name);
      return n;
    });

  // Group loads by cyl type → month, and pre-compute each type's totals so the
  // type header carries the summary (Suneel: "summarise at header level").
  const groups = useMemo(() => {
    if (!data) return [];
    const types = new Map<string, { id: string; name: string; mrp: number; months: Map<string, CostLedgerRow[]> }>();
    for (const r of data.rows) {
      let t = types.get(r.cylinderTypeName);
      if (!t) {
        t = { id: r.cylinderTypeId, name: r.cylinderTypeName, mrp: data.mrpByType[r.cylinderTypeId] ?? 0, months: new Map() };
        types.set(r.cylinderTypeName, t);
      }
      const m = r.date.slice(0, 7);
      const list = t.months.get(m) ?? [];
      list.push(r);
      t.months.set(m, list);
    }
    return [...types.values()].map((t) => {
      const all = [...t.months.values()].flat();
      const recv = all.reduce((s, r) => s + r.qtyReceived, 0);
      const landedVal = all.reduce((s, r) => s + r.landedRate * r.qtyReceived, 0);
      // Margin + MRP are now DATE-EFFECTIVE per row — a July load uses July's
      // MRP, an August load August's. The header shows the qty-weighted blend.
      const mrpVal = all.reduce((s, r) => s + r.mrp * r.qtyReceived, 0);
      const marginVal = all.reduce((s, r) => s + (r.mrp - r.landedRate) * r.qtyReceived, 0);
      const rem = all.reduce((s, r) => s + r.qtyRemaining, 0);
      const remVal = all.reduce((s, r) => s + r.qtyRemaining * r.landedRate, 0);
      const avgLanded = recv > 0 ? landedVal / recv : 0;
      const avgMrp = recv > 0 ? mrpVal / recv : 0;
      const avgMargin = recv > 0 ? marginVal / recv : 0;
      const hasMrp = all.some((r) => r.mrp > 0);
      return { ...t, recv, avgLanded, avgMrp, avgMargin, hasMrp, rem, remVal };
    });
  }, [data]);

  return (
    <details className="rounded-md border border-slate-200 dark:border-surface-700 bg-white dark:bg-surface-800" open>
      <summary className="cursor-pointer bg-slate-50 dark:bg-surface-800 px-3 py-2 text-sm font-medium">
        Cost Layer Ledger · stock value {data ? <b>{fmtMoney(data.totalValue, true)}</b> : null}
      </summary>
      <div className="p-3">
        <p className="mb-2 text-xs text-slate-500 dark:text-surface-400">
          Click a cylinder-type row to expand its loads. Net landed = gross + freight + DN − CN.
          MRP is the Settings selling price <b>effective on each load date</b> (a July load uses the July MRP,
          an August load the August MRP). Margin = that MRP − landed; the type header shows the qty-weighted blend. <b>GST-INCLUSIVE</b>.
        </p>
        {isLoading ? (
          <div className="p-4 text-center text-sm text-slate-500 dark:text-surface-400">Computing…</div>
        ) : !data || data.rows.length === 0 ? (
          <p className="p-4 text-center text-sm text-slate-500 dark:text-surface-400">No cost layers yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-surface-800 text-xs uppercase text-slate-700 dark:text-surface-200">
                <tr>
                  <th className="p-2 text-left">Load Date</th>
                  <th className="p-2 text-left">Load Ref</th>
                  <th className="p-2 text-right">Received</th>
                  <th className="p-2 text-right font-semibold">Landed / Cyl</th>
                  <th className="p-2 text-right">MRP / Cyl</th>
                  <th className="p-2 text-right">Margin / Cyl</th>
                  <th className="p-2 text-right">Remaining</th>
                  <th className="p-2 text-right">Rem. Value</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((t) => {
                  const open = !collapsed.has(t.name);
                  return (
                    <Fragment key={t.name}>
                      {/* Type header — coloured, clickable, carries the summary */}
                      <tr
                        className="cursor-pointer select-none bg-blue-50 dark:bg-blue-900/25 hover:bg-blue-100 dark:hover:bg-blue-900/40 border-y border-blue-200 dark:border-blue-800"
                        onClick={() => toggle(t.name)}
                      >
                        <td colSpan={2} className="p-2 font-semibold text-blue-900 dark:text-blue-200">
                          <span className="inline-block w-4 text-blue-500">{open ? '▾' : '▸'}</span>
                          {t.name}
                          {!t.hasMrp && <span className="ml-2 text-xs font-normal text-amber-600">MRP not set in Settings</span>}
                        </td>
                        <td className="p-2 text-right tabular-nums font-semibold">{t.recv}</td>
                        <td className="p-2 text-right tabular-nums font-semibold">{fmtMoney(t.avgLanded, true)}</td>
                        <td className="p-2 text-right tabular-nums font-semibold">{t.hasMrp ? fmtMoney(t.avgMrp, true) : '—'}</td>
                        <td className={`p-2 text-right tabular-nums font-semibold ${t.hasMrp ? (t.avgMargin >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600') : ''}`}>
                          {t.hasMrp ? fmtMoney(t.avgMargin, true) : '—'}
                        </td>
                        <td className="p-2 text-right tabular-nums font-semibold">{t.rem || '—'}</td>
                        <td className="p-2 text-right tabular-nums font-semibold">{t.remVal > 0 ? fmtMoney(t.remVal) : '—'}</td>
                      </tr>
                      {open && [...t.months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, loads]) => {
                        const sumRecv = loads.reduce((s, r) => s + r.qtyReceived, 0);
                        const sumLine = loads.reduce((s, r) => s + r.grossRate * r.qtyReceived, 0);
                        const sumFrt = loads.reduce((s, r) => s + r.freightPerCyl * r.qtyReceived, 0);
                        const sumCn = loads.reduce((s, r) => s + r.cnPerCyl * r.qtyReceived, 0);
                        const sumDn = loads.reduce((s, r) => s + r.dnPerCyl * r.qtyReceived, 0);
                        const sumLanded = loads.reduce((s, r) => s + r.landedRate * r.qtyReceived, 0);
                        const sumRem = loads.reduce((s, r) => s + r.qtyRemaining, 0);
                        const sumRemVal = loads.reduce((s, r) => s + r.qtyRemaining * r.landedRate, 0);
                        const avgLanded = sumRecv > 0 ? sumLanded / sumRecv : 0;
                        // month's MRP = qty-weighted blend of the loads' date-effective MRPs
                        // (usually a single value since MRP changes monthly).
                        const monthMrp = sumRecv > 0 ? loads.reduce((s, r) => s + r.mrp * r.qtyReceived, 0) / sumRecv : 0;
                        return (
                          <Fragment key={month}>
                            {loads.map((r, i) => (
                              <tr key={r.ref + r.date + i} className={i % 2 ? 'bg-slate-50/60 dark:bg-surface-800/60' : 'bg-white dark:bg-surface-800'}>
                                <td className="p-2 pl-6 whitespace-nowrap text-slate-600 dark:text-surface-300">{r.date}</td>
                                <td className="p-2 font-mono text-xs">{r.ref}</td>
                                <td className="p-2 text-right tabular-nums">{r.qtyReceived}</td>
                                <td className="p-2 text-right tabular-nums font-medium">{fmtMoney(r.landedRate, true)}</td>
                                <td className="p-2 text-right tabular-nums text-slate-600 dark:text-surface-300">{r.mrp > 0 ? fmtMoney(r.mrp, true) : '—'}</td>
                                <td className={`p-2 text-right tabular-nums ${r.mrp > 0 ? (r.mrp - r.landedRate >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600') : ''}`}>
                                  {r.mrp > 0 ? fmtMoney(r.mrp - r.landedRate, true) : '—'}
                                </td>
                                <td className="p-2 text-right tabular-nums">{r.qtyRemaining || '—'}</td>
                                <td className="p-2 text-right tabular-nums">{r.qtyRemaining > 0 ? fmtMoney(r.qtyRemaining * r.landedRate) : '—'}</td>
                              </tr>
                            ))}
                            <tr className="bg-amber-50/50 dark:bg-amber-900/10 text-xs font-semibold">
                              <td className="p-2 pl-6">{month} subtotal</td>
                              <td className="p-2 font-normal text-slate-500 dark:text-surface-400">
                                Line {fmtMoney(sumLine, true)}
                                {sumFrt > 0 && <> · Frt {fmtMoney(sumFrt, true)}</>}
                                {sumCn > 0 && <> · CN −{fmtMoney(sumCn, true)}</>}
                                {sumDn > 0 && <> · DN {fmtMoney(sumDn, true)}</>}
                                {' · '}Landed {fmtMoney(sumLanded, true)}
                              </td>
                              <td className="p-2 text-right tabular-nums">{sumRecv}</td>
                              <td className="p-2 text-right tabular-nums">{fmtMoney(avgLanded, true)}</td>
                              <td className="p-2 text-right tabular-nums">{monthMrp > 0 ? fmtMoney(monthMrp, true) : '—'}</td>
                              <td className="p-2 text-right tabular-nums">{monthMrp > 0 ? fmtMoney(monthMrp - avgLanded, true) : '—'}</td>
                              <td className="p-2 text-right tabular-nums">{sumRem || '—'}</td>
                              <td className="p-2 text-right tabular-nums">{sumRemVal > 0 ? fmtMoney(sumRemVal) : '—'}</td>
                            </tr>
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot className="bg-slate-100 dark:bg-surface-700 text-sm font-semibold">
                <tr>
                  <td colSpan={6} className="p-2 text-right">Total open stock</td>
                  <td className="p-2 text-right tabular-nums">{data.totalRemainingQty}</td>
                  <td className="p-2 text-right tabular-nums">{fmtMoney(data.totalValue, true)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}

function DepositLedgerPanel({ rows, totalDeposits }: { rows: LedgerRow[]; totalDeposits: number }) {
  const deposits = rows.filter((r) => r.kind === 'deposit');
  return (
    <details className="rounded-md border border-slate-200 dark:border-surface-700 bg-white dark:bg-surface-800" open>
      <summary className="cursor-pointer bg-slate-50 dark:bg-surface-800 px-3 py-2 text-sm font-medium">
        Deposit Ledger — {fmtMoney(totalDeposits, true)}
      </summary>
      <div className="p-3">
        <p className="mb-2 text-xs text-slate-500 dark:text-surface-400">
          Deposit invoices are Nil-GST and refundable. Balance does NOT count toward gas outstanding.
        </p>
        {deposits.length === 0 ? (
          <p className="p-4 text-center text-sm text-slate-500 dark:text-surface-400">No deposit invoices in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-surface-800 text-xs uppercase text-slate-700 dark:text-surface-200">
                <tr>
                  <th className="p-2 text-left">Date</th>
                  <th className="p-2 text-left">Doc</th>
                  <th className="p-2 text-left">Narration</th>
                  <th className="p-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {deposits.map((r, i) => (
                  <tr key={r.documentId} className={i % 2 ? 'bg-slate-50 dark:bg-surface-800' : ''}>
                    <td className="p-2">{r.entryDate}</td>
                    <td className="p-2 font-mono text-xs">{r.supplierDocumentNumber ?? r.documentNumber}</td>
                    <td className="p-2">{r.narration}</td>
                    <td className="p-2 text-right font-medium">{fmtMoney(r.debit, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}

// ─── Summary chip ──────────────────────────────────────────────────────────

function SummaryChip({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: 'ok' | 'warn' | 'neutral';
}) {
  const toneClass =
    tone === 'warn'
      ? 'border-amber-300 bg-amber-50 dark:bg-amber-900/20'
      : tone === 'ok'
        ? 'border-emerald-300 bg-emerald-50'
        : 'border-slate-200 dark:border-surface-700 bg-white dark:bg-surface-800';
  return (
    <div className={`rounded-md border p-3 ${toneClass}`}>
      <div className="text-xs uppercase text-slate-600 dark:text-surface-300">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      <div className="text-xs text-slate-500 dark:text-surface-400">{hint}</div>
    </div>
  );
}

// ─── Add Entry dropdown ─────────────────────────────────────────────────────

type AddEntryKind =
  | 'incoming_fulls'
  | 'outgoing_empties'
  | 'payment'
  | 'credit_note'
  | 'debit_note'
  | 'deposit';

function AddEntryButton({ onPick }: { onPick: (kind: AddEntryKind) => void }) {
  const [open, setOpen] = useState(false);
  // F8v2-FIX-A (2026-08-06) — no navigate() for Outgoing Empties. Every
  // option opens its modal IN PLACE on the Corp Ledger page (same modal
  // shown on Inventory page for Incoming/Outgoing — imported directly).
  const items: Array<{ label: string; kind: AddEntryKind; hint?: string }> = [
    { label: 'Incoming Fulls', kind: 'incoming_fulls', hint: 'Gas cylinders received from Bottling / Refill Plant to Godown' },
    { label: 'Outgoing Empties', kind: 'outgoing_empties', hint: 'Empty cylinders sent from Godown to Bottling / Refill Plant' },
    { label: 'Payment', kind: 'payment', hint: 'Money you paid the OMC' },
    { label: 'Credit Note', kind: 'credit_note', hint: 'OMC issued you a CN (incentive)' },
    { label: 'Debit Note', kind: 'debit_note', hint: 'OMC billed you extra (short supply, damage)' },
    { label: 'Deposit', kind: 'deposit', hint: 'Cylinder deposit invoice (Nil GST)' },
  ];
  return (
    <div className="relative">
      <Button onClick={() => setOpen((v) => !v)}>
        + Add Entry <HiOutlineChevronDown className="ml-1 inline" />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 z-20 mt-1 w-72 rounded-md border border-slate-200 dark:border-surface-700 bg-white dark:bg-surface-800 shadow-lg">
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50 dark:bg-surface-800"
                onClick={() => {
                  onPick(it.kind);
                  setOpen(false);
                }}
              >
                <div className="font-medium">{it.label}</div>
                {it.hint && <div className="text-xs text-slate-500 dark:text-surface-400">{it.hint}</div>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
