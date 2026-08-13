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
import { useMemo, useState } from 'react';
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
    queryKey: ['vehicles-active-corp'],
    queryFn: async () => {
      const res = await apiGet<{ vehicles?: unknown[] } | unknown[]>('/vehicles', { status: 'idle,dispatched,returned,reconciled' });
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
              <th className="p-2 text-right">Debit</th>
              <th className="p-2 text-right">Credit</th>
              <th className="p-2 text-right">Balance</th>
              <th className="p-2 text-center">Dr/Cr</th>
            </tr>
          </thead>
          <tbody>
            {ledgerLoading ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-slate-500 dark:text-surface-400">
                  Loading ledger…
                </td>
              </tr>
            ) : filteredRows.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-slate-500 dark:text-surface-400">
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

      {/* Physical Activity — recent ERV / Incoming pulled from the same ledger,
          filtered to physical-only rows. */}
      <PhysicalActivityPanel rows={filteredRows} />

      {/* Landed Cost — per cyl type per month grid */}
      <LandedCostPanel corpId={activeCorpId} from={from} to={to} />

      {/* Cost Layer Ledger — FIFO open loads with gross→CN→net + stock value */}
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

function PhysicalActivityPanel({ rows }: { rows: LedgerRow[] }) {
  const physical = rows.filter(
    (r) => r.kind === 'erv_empties' || r.kind === 'erv_defective' || r.kind === 'purchase' || r.kind === 'deposit',
  );
  if (physical.length === 0) {
    return (
      <details className="rounded-md border border-slate-200 dark:border-surface-700 bg-white dark:bg-surface-800" open>
        <summary className="cursor-pointer bg-slate-50 dark:bg-surface-800 px-3 py-2 text-sm font-medium">
          Physical Activity
        </summary>
        <p className="p-4 text-center text-sm text-slate-500 dark:text-surface-400">No physical activity in the selected period.</p>
      </details>
    );
  }
  return (
    <details className="rounded-md border border-slate-200 dark:border-surface-700 bg-white dark:bg-surface-800" open>
      <summary className="cursor-pointer bg-slate-50 dark:bg-surface-800 px-3 py-2 text-sm font-medium">
        Physical Activity — Incoming / Empties / Defective ({physical.length} events)
      </summary>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-surface-800 text-xs uppercase text-slate-700 dark:text-surface-200">
            <tr>
              <th className="p-2 text-left">Date</th>
              <th className="p-2 text-left">Kind</th>
              <th className="p-2 text-left">Cyl / Detail</th>
              <th className="p-2 text-right">Qty</th>
              <th className="p-2 text-left">Doc</th>
            </tr>
          </thead>
          <tbody>
            {physical.map((r, i) => (
              <tr key={r.documentId + r.kind} className={i % 2 ? 'bg-slate-50 dark:bg-surface-800' : ''}>
                <td className="p-2 whitespace-nowrap">{r.entryDate}</td>
                <td className="p-2 whitespace-nowrap text-xs font-medium">{KIND_LABELS[r.kind]}</td>
                <td className="p-2">{r.cylinderTypeName ?? r.narration}</td>
                <td className="p-2 text-right">{r.physicalQty ?? '—'}</td>
                <td className="p-2 font-mono text-xs">{r.supplierDocumentNumber ?? r.documentNumber ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

interface LandedCostRow {
  month: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  cylindersReceived: number;
  lineTotal: number;
  freightAllocated: number;
  cnOffset: number;
  dnOffset: number;
  landedTotal: number;
  landedPerCyl: number;
  gstMode: 'live' | 'sandbox' | 'disabled';
}

interface LandedCostResponse {
  rows: LandedCostRow[];
  summary: {
    cylTypes: number;
    months: number;
    totalCylsReceived: number;
    totalLineValue: number;
    totalFreight: number;
    totalCnOffset: number;
    totalDnOffset: number;
    grandLanded: number;
  };
  gstMode: 'live' | 'sandbox' | 'disabled';
}

function LandedCostPanel({ corpId, from, to }: { corpId: string; from: string; to: string }) {
  const { data, isLoading } = useQuery<LandedCostResponse>({
    queryKey: ['corp-landed-cost', corpId, from, to],
    queryFn: () =>
      apiGet<LandedCostResponse>('/purchase-payments/landed-cost', {
        sourceDistributorId: corpId,
        from,
        to,
      }),
    enabled: Boolean(corpId),
  });
  return (
    <details className="rounded-md border border-slate-200 dark:border-surface-700 bg-white dark:bg-surface-800" open>
      <summary className="cursor-pointer bg-slate-50 dark:bg-surface-800 px-3 py-2 text-sm font-medium">
        Landed Cost per Cylinder — per type, per month
      </summary>
      <div className="p-3">
        <p className="mb-2 text-xs text-slate-500 dark:text-surface-400">
          Formula: (line total + freight + DN − CN) ÷ cylinders received.{' '}
          {data?.gstMode && data.gstMode !== 'disabled' && (
            <b>GST-EXCLUSIVE</b>
          )}{' '}
          {data?.gstMode === 'disabled' && (
            <span>GST-inclusive (ITC not claimed — tax is real cost).</span>
          )}
        </p>
        {isLoading ? (
          <div className="p-4 text-center text-sm text-slate-500 dark:text-surface-400">Computing…</div>
        ) : !data || data.rows.length === 0 ? (
          <p className="p-4 text-center text-sm text-slate-500 dark:text-surface-400">
            No landed-cost activity in this period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-surface-800 text-xs uppercase text-slate-700 dark:text-surface-200">
                <tr>
                  <th className="p-2 text-left">Month</th>
                  <th className="p-2 text-left">Cyl Type</th>
                  <th className="p-2 text-right">Received</th>
                  <th className="p-2 text-right">Line ₹</th>
                  <th className="p-2 text-right">Freight ₹</th>
                  <th className="p-2 text-right">CN ₹</th>
                  <th className="p-2 text-right">DN ₹</th>
                  <th className="p-2 text-right">Landed Total ₹</th>
                  <th className="p-2 text-right font-semibold">Landed / Cyl</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={r.month + r.cylinderTypeId} className={i % 2 ? 'bg-slate-50 dark:bg-surface-800' : ''}>
                    <td className="p-2">{r.month}</td>
                    <td className="p-2">{r.cylinderTypeName}</td>
                    <td className="p-2 text-right">{r.cylindersReceived}</td>
                    <td className="p-2 text-right">{fmtMoney(r.lineTotal)}</td>
                    <td className="p-2 text-right">{fmtMoney(r.freightAllocated)}</td>
                    <td className="p-2 text-right">{fmtMoney(r.cnOffset)}</td>
                    <td className="p-2 text-right">{fmtMoney(r.dnOffset)}</td>
                    <td className="p-2 text-right">{fmtMoney(r.landedTotal, true)}</td>
                    <td className="p-2 text-right font-semibold">{fmtMoney(r.landedPerCyl, true)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-100 dark:bg-surface-700 text-sm font-semibold">
                <tr>
                  <td colSpan={2} className="p-2 text-right">Totals</td>
                  <td className="p-2 text-right">{data.summary.totalCylsReceived}</td>
                  <td className="p-2 text-right">{fmtMoney(data.summary.totalLineValue, true)}</td>
                  <td className="p-2 text-right">{fmtMoney(data.summary.totalFreight)}</td>
                  <td className="p-2 text-right">{fmtMoney(data.summary.totalCnOffset)}</td>
                  <td className="p-2 text-right">{fmtMoney(data.summary.totalDnOffset)}</td>
                  <td className="p-2 text-right">{fmtMoney(data.summary.grandLanded, true)}</td>
                  <td className="p-2 text-right">—</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}

// ─── Cost Layer Ledger (FIFO) ───────────────────────────────────────────────
// Live open purchase loads per cyl type with gross → OMC discount (CN) → net
// landed rate, remaining qty, and stock value. This is the "running counter
// per cylinder type as per the load and its landed price" (design §6). Any
// delivered stock with no purchase layer behind it shows as an uncosted
// warning (opening stock not yet entered).
interface CostLayerRow {
  cylinderTypeName: string;
  date: string;
  ref: string;
  qtyReceived: number;
  qtyRemaining: number;
  grossRate: number;
  cnPerCyl: number;
  dnPerCyl: number;
  landedRate: number;
  isOpening: boolean;
}
interface CostLayersResponse {
  gstMode: 'live' | 'sandbox' | 'disabled';
  totalRemainingQty: number;
  totalValue: number;
  uncostedQty: number;
  openLayers: CostLayerRow[];
}

function CostLayerLedgerPanel() {
  const { data, isLoading } = useQuery<CostLayersResponse>({
    queryKey: ['corp-cost-layers'],
    queryFn: () => apiGet<CostLayersResponse>('/purchase-payments/cost-layers'),
  });
  return (
    <details className="rounded-md border border-slate-200 dark:border-surface-700 bg-white dark:bg-surface-800" open>
      <summary className="cursor-pointer bg-slate-50 dark:bg-surface-800 px-3 py-2 text-sm font-medium">
        Cost Layer Ledger — open loads (FIFO) · stock value{' '}
        {data ? <b>{fmtMoney(data.totalValue, true)}</b> : null}
      </summary>
      <div className="p-3">
        <p className="mb-2 text-xs text-slate-500 dark:text-surface-400">
          Each still-open purchase load, oldest first. Net landed rate ={' '}
          gross − OMC discount (CN) + extra billed (DN).{' '}
          {data?.gstMode && data.gstMode !== 'disabled' && <b>GST-EXCLUSIVE</b>}
        </p>
        {data && data.uncostedQty > 0 && (
          <p className="mb-2 rounded-md bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800">
            ⚠️ {data.uncostedQty} delivered cylinder(s) have no purchase load behind them
            (opening stock not entered yet) — these are excluded from cost until you record
            an opening entry.
          </p>
        )}
        {isLoading ? (
          <div className="p-4 text-center text-sm text-slate-500 dark:text-surface-400">Computing…</div>
        ) : !data || data.openLayers.length === 0 ? (
          <p className="p-4 text-center text-sm text-slate-500 dark:text-surface-400">No open cost layers.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-surface-800 text-xs uppercase text-slate-700 dark:text-surface-200">
                <tr>
                  <th className="p-2 text-left">Cyl Type</th>
                  <th className="p-2 text-left">Load Date</th>
                  <th className="p-2 text-left">Load Ref</th>
                  <th className="p-2 text-right">Received</th>
                  <th className="p-2 text-right">Remaining</th>
                  <th className="p-2 text-right">Gross / Cyl</th>
                  <th className="p-2 text-right">OMC Disc / Cyl</th>
                  <th className="p-2 text-right font-semibold">Net Landed / Cyl</th>
                  <th className="p-2 text-right">Remaining Value</th>
                </tr>
              </thead>
              <tbody>
                {data.openLayers.map((L, i) => (
                  <tr key={L.ref + L.date + L.cylinderTypeName} className={i % 2 ? 'bg-slate-50 dark:bg-surface-800' : ''}>
                    <td className="p-2">{L.cylinderTypeName}</td>
                    <td className="p-2">{L.date}</td>
                    <td className="p-2 font-mono text-xs">
                      {L.ref}
                      {L.isOpening && <span className="ml-1 rounded bg-slate-200 dark:bg-surface-700 px-1 text-[10px]">opening</span>}
                    </td>
                    <td className="p-2 text-right">{L.qtyReceived}</td>
                    <td className="p-2 text-right font-medium">{L.qtyRemaining}</td>
                    <td className="p-2 text-right">{fmtMoney(L.grossRate, true)}</td>
                    <td className="p-2 text-right text-green-700 dark:text-green-400">
                      {L.cnPerCyl > 0 ? `− ${fmtMoney(L.cnPerCyl, true)}` : '—'}
                    </td>
                    <td className="p-2 text-right font-semibold">{fmtMoney(L.landedRate, true)}</td>
                    <td className="p-2 text-right">{fmtMoney(L.qtyRemaining * L.landedRate)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-100 dark:bg-surface-700 text-sm font-semibold">
                <tr>
                  <td colSpan={4} className="p-2 text-right">Total open stock</td>
                  <td className="p-2 text-right">{data.totalRemainingQty}</td>
                  <td colSpan={3} className="p-2 text-right">Stock value</td>
                  <td className="p-2 text-right">{fmtMoney(data.totalValue, true)}</td>
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
