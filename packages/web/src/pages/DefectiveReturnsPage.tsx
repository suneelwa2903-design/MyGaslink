/**
 * DefectiveReturnsPage — F1 web UI (2026-08-06).
 *
 * See docs/F1-DEFECTIVE-RETURNS-DESIGN.md for the full functional spec.
 *
 * Two tabs:
 *   1. New Entry — 4-step wizard: customer → invoice + qty → confirm capture
 *                  → check ledger → raise CN → check ledger
 *   2. History  — table with all past defective returns (status + CN link)
 *
 * Sidebar chip pending count is wired via useQuery(['defective-returns-pending-count'])
 * in Sidebar.tsx — this page invalidates that key on capture + raise-cn.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Loader, EmptyState, Modal } from '@/components/ui';
import { CustomerSearchInput } from '@/components/ui/CustomerSearchInput';

// F1: local INR formatter — matches the pattern used elsewhere (e.g. CustomersPage:46).
function formatINR(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
}
import type {
  DefectiveReturn,
  DefectiveEligibleInvoice,
  DefectiveDepotBucketRow,
} from '@gaslink/shared';

type Tab = 'new' | 'history' | 'send-to-corp';

// F1-FIX-6 (2026-08-06) — one-shot flow per Suneel. Wizard collapsed from
// 4 steps ("pick-customer → pick-invoice-and-qty → confirmed → cn-raised")
// down to 2: pick-customer → pick-invoice-and-qty. On submit, backend
// capture + CN fire atomically; success returns to pick-customer for the
// next entry, failure surfaces via toast. No more "check ledger then
// raise CN" intermediate — office wanted one click.
type WizardStep =
  | { kind: 'pick-customer' }
  | { kind: 'pick-invoice-and-qty'; customerId: string; customerName: string };

export default function DefectiveReturnsPage() {
  const [tab, setTab] = useState<Tab>('new');
  const [wizard, setWizard] = useState<WizardStep>({ kind: 'pick-customer' });

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Defective Cylinder Returns
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Office-entered: record defective full cylinders picked up from customers, raise credit notes, then ship the depot bucket back to the corporation.
        </p>
      </header>

      {/* Tab bar */}
      <div className="flex gap-2 border-b border-slate-200 dark:border-slate-800 mb-4">
        <TabButton active={tab === 'new'} onClick={() => setTab('new')}>New Entry</TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')}>History</TabButton>
        <TabButton active={tab === 'send-to-corp'} onClick={() => setTab('send-to-corp')}>Send to Corporation</TabButton>
      </div>

      {tab === 'new' && (
        <NewEntryTab wizard={wizard} setWizard={setWizard} />
      )}
      {tab === 'history' && <HistoryTab />}
      {tab === 'send-to-corp' && <SendToCorpTab />}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'px-4 py-2 border-b-2 border-brand-500 text-brand-600 dark:text-brand-400 font-medium'
          : 'px-4 py-2 border-b-2 border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
      }
    >
      {children}
    </button>
  );
}

// ─── New Entry wizard ────────────────────────────────────────────────────────

function NewEntryTab({ wizard, setWizard }: { wizard: WizardStep; setWizard: (w: WizardStep) => void }) {
  return (
    <div className="space-y-6">
      {wizard.kind === 'pick-customer' && (
        <PickCustomer
          onPick={(customerId, customerName) =>
            setWizard({ kind: 'pick-invoice-and-qty', customerId, customerName })
          }
        />
      )}
      {wizard.kind === 'pick-invoice-and-qty' && (
        <PickInvoiceAndQty
          customerId={wizard.customerId}
          customerName={wizard.customerName}
          onDone={() => setWizard({ kind: 'pick-customer' })}
          onBack={() => setWizard({ kind: 'pick-customer' })}
        />
      )}
    </div>
  );
}

function PickCustomer({ onPick }: { onPick: (customerId: string, customerName: string) => void }) {
  const [customerId, setCustomerId] = useState('');
  const [customerName, setCustomerName] = useState('');

  return (
    <section className="bg-white dark:bg-slate-900 rounded-xl p-6 shadow-sm border border-slate-200 dark:border-slate-800">
      <h2 className="text-lg font-medium mb-4 text-slate-900 dark:text-slate-100">
        Step 1 — Select Customer
      </h2>
      <CustomerSearchInput
        value={customerId}
        onChange={(id, customer) => {
          setCustomerId(id);
          setCustomerName(customer?.customerName ?? '');
        }}
        placeholder="Search customer by name or phone..."
      />
      <div className="mt-4">
        <Button
          type="button"
          onClick={() => customerId && onPick(customerId, customerName)}
          disabled={!customerId}
        >
          Continue →
        </Button>
      </div>
    </section>
  );
}

function PickInvoiceAndQty({
  customerId,
  customerName,
  onDone,
  onBack,
}: {
  customerId: string;
  customerName: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const [selectedQtys, setSelectedQtys] = useState<Record<string, Record<string, number>>>({});
  // Structure: { [invoiceId]: { [cylTypeId]: qty } } — but per Q4, only ONE
  // invoice can be selected per capture. Enforce single-invoice below.
  const [chosenInvoiceId, setChosenInvoiceId] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [collectedDate, setCollectedDate] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [busy, setBusy] = useState(false);

  const queryClient = useQueryClient();

  const { data: invoices, isLoading } = useQuery({
    queryKey: ['defective-eligible-invoices', customerId],
    queryFn: () => apiGet<DefectiveEligibleInvoice[]>('/defective-returns/eligible-invoices', { customerId }),
    enabled: !!customerId,
  });

  const previewAmount = useMemo(() => {
    if (!chosenInvoiceId || !invoices) return 0;
    const inv = invoices.find((i) => i.invoiceId === chosenInvoiceId);
    if (!inv) return 0;
    const qtysForInv = selectedQtys[chosenInvoiceId] ?? {};
    let total = 0;
    for (const line of inv.lines) {
      const q = qtysForInv[line.cylinderTypeId] ?? 0;
      total += q * line.perCylRate;
    }
    return Math.round(total * 100) / 100;
  }, [chosenInvoiceId, invoices, selectedQtys]);

  const hasAnyQty = useMemo(() => {
    if (!chosenInvoiceId) return false;
    const qtys = selectedQtys[chosenInvoiceId] ?? {};
    return Object.values(qtys).some((q) => q > 0);
  }, [chosenInvoiceId, selectedQtys]);

  // F1-FIX-6 (2026-08-06) — one-shot per Suneel: capture + auto-raise CN
  // as a single click. If capture succeeds but CN raise fires fails, warn
  // (row still lives at status='collected' and can be resolved from
  // History → Raise CN).
  const handleSubmit = async () => {
    if (!chosenInvoiceId) return;
    const inv = invoices?.find((i) => i.invoiceId === chosenInvoiceId);
    if (!inv) return;
    const qtys = selectedQtys[chosenInvoiceId] ?? {};
    const items = Object.entries(qtys)
      .filter(([, q]) => q > 0)
      .map(([cylTypeId, q]) => ({ cylinderTypeId: cylTypeId, quantity: q }));
    if (items.length === 0) { toast.error('Enter at least one defective quantity'); return; }
    setBusy(true);
    let cap: { defectiveIds: string[]; cnAmountPreview: number } | null = null;
    try {
      cap = await apiPost<{ defectiveIds: string[]; cnAmountPreview: number }>('/defective-returns', {
        customerId,
        sourceInvoiceId: chosenInvoiceId,
        collectedDate,
        items,
        reason: reason.trim() || undefined,
        notes: notes.trim() || undefined,
      });
    } catch (err) {
      toast.error(getErrorMessage(err));
      setBusy(false);
      return;
    }
    try {
      const cn = await apiPost<{ creditNoteId: string; cnNumber: string; cnAmount: number }>(
        `/defective-returns/${cap.defectiveIds[0]}/raise-cn`,
        { defectiveIds: cap.defectiveIds, reason: 'Defective cylinder return' },
      );
      queryClient.invalidateQueries({ queryKey: ['defective-returns-pending-count'] });
      queryClient.invalidateQueries({ queryKey: ['defective-returns-history'] });
      queryClient.invalidateQueries({ queryKey: ['defective-depot-bucket'] });
      queryClient.invalidateQueries({ queryKey: ['defective-eligible-invoices', customerId] });
      toast.success(`✓ ${customerName}: recorded + CN ${cn.cnNumber} for ₹${cn.cnAmount.toLocaleString('en-IN')}`);
      setBusy(false);
      onDone();
    } catch (err) {
      queryClient.invalidateQueries({ queryKey: ['defective-returns-pending-count'] });
      queryClient.invalidateQueries({ queryKey: ['defective-returns-history'] });
      toast.error(
        `Defective captured for ${customerName} but CN raise failed: ${getErrorMessage(err)}. ` +
        `Fix + click "Raise CN" from History.`,
        { duration: 10_000 },
      );
      setBusy(false);
      onDone();
    }
  };

  if (isLoading) {
    return <div className="p-8 text-center"><Loader /></div>;
  }

  return (
    <section className="bg-white dark:bg-slate-900 rounded-xl p-6 shadow-sm border border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium text-slate-900 dark:text-slate-100">
          Step 2 — Pick invoice + defective quantities
        </h2>
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
        >
          ← Change customer
        </button>
      </div>
      <div className="mb-4 text-sm text-slate-600 dark:text-slate-400">
        Customer: <span className="font-medium text-slate-900 dark:text-slate-100">{customerName}</span>
      </div>

      {(!invoices || invoices.length === 0) && (
        <EmptyState
          title="No invoices in the last 90 days"
          description="Defective returns can only be raised against invoices from the last 90 days. Older invoices are beyond the CN cut-off window."
        />
      )}

      {invoices && invoices.length > 0 && (
        <div className="space-y-4">
          <div className="space-y-3">
            {invoices.map((inv) => {
              const isChosen = chosenInvoiceId === inv.invoiceId;
              return (
                <div
                  key={inv.invoiceId}
                  className={`border rounded-lg p-4 ${isChosen ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20' : 'border-slate-200 dark:border-slate-700'}`}
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="radio"
                      name="invoice"
                      checked={isChosen}
                      onChange={() => setChosenInvoiceId(inv.invoiceId)}
                    />
                    <div className="flex-1">
                      <div className="font-medium text-slate-900 dark:text-slate-100">
                        {inv.invoiceNumber}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {inv.issueDate} · {formatINR(inv.totalAmount)} · {inv.paymentStatus}
                      </div>
                    </div>
                  </div>
                  {isChosen && (
                    <div className="mt-3 space-y-2 pl-6">
                      {inv.lines.map((line) => {
                        const curr = selectedQtys[inv.invoiceId]?.[line.cylinderTypeId] ?? 0;
                        return (
                          <div key={line.invoiceItemId} className="grid grid-cols-[1fr_100px_120px] gap-3 items-center">
                            <div className="text-sm">
                              <div className="font-medium text-slate-900 dark:text-slate-100">
                                {line.cylinderTypeName}
                              </div>
                              <div className="text-xs text-slate-500 dark:text-slate-400">
                                Rate: {formatINR(line.perCylRate)} · Available: {line.remainingQty} of {line.qty}
                                {line.alreadyClaimedQty > 0 && ` (${line.alreadyClaimedQty} already claimed)`}
                              </div>
                            </div>
                            <Input
                              type="number"
                              min={0}
                              max={line.remainingQty}
                              value={curr}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(line.remainingQty, Number(e.target.value) || 0));
                                setSelectedQtys((prev) => ({
                                  ...prev,
                                  [inv.invoiceId]: {
                                    ...(prev[inv.invoiceId] ?? {}),
                                    [line.cylinderTypeId]: v,
                                  },
                                }));
                              }}
                              disabled={line.remainingQty === 0}
                            />
                            <div className="text-right text-sm text-slate-600 dark:text-slate-400">
                              = {formatINR(curr * line.perCylRate)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {chosenInvoiceId && (
            <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Collected date
                </label>
                <Input
                  type="date"
                  value={collectedDate}
                  onChange={(e) => setCollectedDate(e.target.value)}
                  max={(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })()}
                />
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Reason (optional)
                  </label>
                  <Select
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    options={[
                      { value: '', label: '— none —' },
                      { value: 'Leaky valve', label: 'Leaky valve' },
                      { value: 'Bad seal', label: 'Bad seal' },
                      { value: 'Low weight', label: 'Low weight' },
                      { value: 'Damaged body', label: 'Damaged body' },
                      { value: 'Other', label: 'Other' },
                    ]}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Notes (optional)
                  </label>
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Extra context..." />
                </div>
              </div>

              <div className="bg-slate-100 dark:bg-slate-800 rounded-lg p-4 flex items-center justify-between">
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 uppercase">
                    Credit note amount (preview)
                  </div>
                  <div className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
                    {formatINR(previewAmount)}
                  </div>
                </div>
                <Button
                  onClick={handleSubmit}
                  disabled={!hasAnyQty || busy}
                  loading={busy}
                >
                  Record Defective Return &amp; Raise CN
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// F1-FIX-6 (2026-08-06): CapturedConfirmation + CnRaisedSuccess components
// removed. The two-step "check ledger then raise CN" dance was replaced by
// a single-shot "Record Defective Return & Raise CN" button — Suneel
// wanted one click, and if anything fails the History page's "Raise CN"
// button is the fallback.

// ─── History tab ─────────────────────────────────────────────────────────────

function HistoryTab() {
  const [statusFilter, setStatusFilter] = useState('');
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['defective-returns-history', statusFilter],
    queryFn: () => apiGet<DefectiveReturn[]>('/defective-returns', statusFilter ? { status: statusFilter } : undefined),
  });

  // F1-FIX-2 (2026-08-06) — Raise CN + Cancel from History. Fixes the gap
  // where office could only raise CN from the just-captured confirmation
  // card; if they navigated away, the only path back was through the DB.
  const raiseCnMut = useMutation({
    mutationFn: (defectiveId: string) =>
      apiPost<{ creditNoteId: string; cnNumber: string; cnAmount: number }>(
        `/defective-returns/${defectiveId}/raise-cn`,
        { defectiveIds: [defectiveId], reason: 'Defective cylinder return' },
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['defective-returns-history'] });
      queryClient.invalidateQueries({ queryKey: ['defective-returns-pending-count'] });
      queryClient.invalidateQueries({ queryKey: ['defective-depot-bucket'] });
      toast.success(`CN ${data.cnNumber} raised for ${formatINR(data.cnAmount)}`);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const cancelMut = useMutation({
    mutationFn: (defectiveId: string) =>
      apiPost(`/defective-returns/${defectiveId}/cancel`, { reason: 'Cancelled from History' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['defective-returns-history'] });
      queryClient.invalidateQueries({ queryKey: ['defective-returns-pending-count'] });
      toast.success('Defective row cancelled — customer balance restored');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <section className="bg-white dark:bg-slate-900 rounded-xl p-6 shadow-sm border border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium text-slate-900 dark:text-slate-100">History</h2>
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="w-52"
          options={[
            { value: '', label: 'All statuses' },
            { value: 'collected', label: 'Collected (CN pending)' },
            { value: 'cn_issued', label: 'CN issued' },
            { value: 'sent_to_corporation', label: 'Sent to corporation' },
            { value: 'corporation_credit_received', label: 'Corp credit received' },
            { value: 'cancelled', label: 'Cancelled' },
          ]}
        />
      </div>
      {isLoading && <div className="text-center py-6"><Loader /></div>}
      {!isLoading && (!data || data.length === 0) && (
        <EmptyState title="No defective returns yet" description="Nothing captured for this distributor." />
      )}
      {!isLoading && data && data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-xs text-slate-500 dark:text-slate-400 uppercase">
                <th className="py-2 pr-4">Date</th>
                <th className="py-2 pr-4">Customer</th>
                <th className="py-2 pr-4">Source Invoice</th>
                <th className="py-2 pr-4">Invoice Amt</th>
                <th className="py-2 pr-4">Cyl Type</th>
                <th className="py-2 pr-4 text-right">Defective Qty</th>
                <th className="py-2 pr-4">CN #</th>
                <th className="py-2 pr-4 text-right">CN Amount</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => {
                const isBusy =
                  (raiseCnMut.isPending && raiseCnMut.variables === row.id) ||
                  (cancelMut.isPending && cancelMut.variables === row.id);
                return (
                  <tr key={row.id} className="border-b border-slate-100 dark:border-slate-800/50">
                    <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">{row.collectedDate}</td>
                    <td className="py-2 pr-4 font-medium text-slate-900 dark:text-slate-100">{row.customerName}</td>
                    <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">{row.sourceInvoiceNumber ?? '—'}</td>
                    <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">{row.sourceInvoiceAmount != null ? formatINR(row.sourceInvoiceAmount) : '—'}</td>
                    <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">{row.cylinderTypeName}</td>
                    <td className="py-2 pr-4 text-right font-medium text-slate-900 dark:text-slate-100">{row.quantity}</td>
                    <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">{row.creditNoteNumber ?? '—'}</td>
                    <td className="py-2 pr-4 text-right text-slate-700 dark:text-slate-300">{formatINR(row.cnAmount)}</td>
                    <td className="py-2 pr-4"><StatusBadge status={row.status} /></td>
                    <td className="py-2 pr-4">
                      {row.status === 'collected' ? (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                            onClick={() => {
                              if (window.confirm(`Raise CN of ${formatINR(row.cnAmount)} against ${row.sourceInvoiceNumber} for ${row.customerName}?`)) {
                                raiseCnMut.mutate(row.id);
                              }
                            }}
                            disabled={isBusy}
                          >
                            {isBusy && raiseCnMut.isPending ? 'Raising…' : 'Raise CN'}
                          </button>
                          <button
                            type="button"
                            className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                            onClick={() => {
                              if (window.confirm(`Cancel this defective row? Customer's holding for ${row.cylinderTypeName} will be restored.`)) {
                                cancelMut.mutate(row.id);
                              }
                            }}
                            disabled={isBusy}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400 dark:text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    collected: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    cn_issued: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    sent_to_corporation: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
    corporation_credit_received: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    cancelled: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  };
  const label: Record<string, string> = {
    collected: 'CN pending',
    cn_issued: 'CN issued',
    sent_to_corporation: 'Sent to corp',
    corporation_credit_received: 'Corp credit rec.',
    cancelled: 'Cancelled',
  };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${styles[status] ?? styles.collected}`}>
      {label[status] ?? status}
    </span>
  );
}

// ─── Send to Corporation tab ─────────────────────────────────────────────────

function SendToCorpTab() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [corpName, setCorpName] = useState('IOCL');
  const [challanNumber, setChallanNumber] = useState('');
  const [challanDate, setChallanDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [notes, setNotes] = useState('');
  const queryClient = useQueryClient();

  const { data: bucket } = useQuery({
    queryKey: ['defective-depot-bucket'],
    queryFn: () => apiGet<DefectiveDepotBucketRow[]>('/defective-returns/depot-bucket'),
  });

  const { data: readyRows } = useQuery({
    queryKey: ['defective-returns-history', 'cn_issued'],
    queryFn: () => apiGet<DefectiveReturn[]>('/defective-returns', { status: 'cn_issued' }),
  });

  const createBatchMut = useMutation({
    mutationFn: (payload: unknown) => apiPost<{ batchId: string; batchNumber: string; totalQuantity: number }>('/defective-returns/batches', payload),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['defective-depot-bucket'] });
      queryClient.invalidateQueries({ queryKey: ['defective-returns-history'] });
      queryClient.invalidateQueries({ queryKey: ['defective-returns-history', 'cn_issued'] });
      setSelectedIds(new Set());
      setModalOpen(false);
      // No internal FSHD batch number in operator-facing copy.
      toast.success(`Sent — ${data.totalQuantity} cyl to ${corpName}`);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const totalSelected = useMemo(() => {
    if (!readyRows) return 0;
    return readyRows.filter((r) => selectedIds.has(r.id)).reduce((s, r) => s + r.quantity, 0);
  }, [readyRows, selectedIds]);

  return (
    <section className="bg-white dark:bg-slate-900 rounded-xl p-6 shadow-sm border border-slate-200 dark:border-slate-800">
      <h2 className="text-lg font-medium mb-2 text-slate-900 dark:text-slate-100">
        Depot bucket — defective fulls ready to ship to corporation
      </h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
        Only rows where the CN has been raised appear here. Tick the ones going in this shipment, capture the challan, and record.
      </p>

      {(!bucket || bucket.length === 0) && (
        <EmptyState title="Depot bucket empty" description="No defective fulls awaiting return to corporation." />
      )}

      {bucket && bucket.length > 0 && (
        <>
          <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {bucket.map((b) => (
              <div key={b.cylinderTypeId} className="bg-slate-100 dark:bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-500 dark:text-slate-400 uppercase">{b.cylinderTypeName}</div>
                <div className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{b.qty}</div>
              </div>
            ))}
          </div>

          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-xs text-slate-500 dark:text-slate-400 uppercase">
                <th className="py-2 pr-4">
                  <input
                    type="checkbox"
                    checked={readyRows != null && selectedIds.size === readyRows.length && readyRows.length > 0}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedIds(new Set(readyRows?.map((r) => r.id) ?? []));
                      else setSelectedIds(new Set());
                    }}
                  />
                </th>
                <th className="py-2 pr-4">CN #</th>
                <th className="py-2 pr-4">Customer</th>
                <th className="py-2 pr-4">Cyl Type</th>
                <th className="py-2 pr-4 text-right">Qty</th>
                <th className="py-2 pr-4">Collected</th>
              </tr>
            </thead>
            <tbody>
              {readyRows?.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 dark:border-slate-800/50">
                  <td className="py-2 pr-4">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(row.id)}
                      onChange={(e) => {
                        const next = new Set(selectedIds);
                        if (e.target.checked) next.add(row.id);
                        else next.delete(row.id);
                        setSelectedIds(next);
                      }}
                    />
                  </td>
                  <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">{row.creditNoteNumber ?? '—'}</td>
                  <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">{row.customerName}</td>
                  <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">{row.cylinderTypeName}</td>
                  <td className="py-2 pr-4 text-right font-medium text-slate-900 dark:text-slate-100">{row.quantity}</td>
                  <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">{row.collectedDate}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-800 pt-4">
            <div className="text-sm text-slate-600 dark:text-slate-400">
              {selectedIds.size} row(s) selected · {totalSelected} cylinders
            </div>
            <Button
              onClick={() => setModalOpen(true)}
              disabled={selectedIds.size === 0}
            >
              Record Shipment →
            </Button>
          </div>
        </>
      )}

      {/* Send-to-corp modal */}
      {modalOpen && (
        <Modal open onClose={() => setModalOpen(false)} title="Send defective batch to corporation">
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Corporation</label>
              <Select
                value={corpName}
                onChange={(e) => setCorpName(e.target.value)}
                options={[
                  { value: 'IOCL', label: 'IOCL' },
                  { value: 'HPCL', label: 'HPCL' },
                  { value: 'BPCL', label: 'BPCL' },
                  { value: 'Reliance', label: 'Reliance' },
                  { value: 'Other', label: 'Other' },
                ]}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Challan No.</label>
                <Input value={challanNumber} onChange={(e) => setChallanNumber(e.target.value)} placeholder="RC/2026/…" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Challan Date</label>
                <Input type="date" value={challanDate} onChange={(e) => setChallanDate(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Notes (optional)</label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <div className="bg-slate-100 dark:bg-slate-800 rounded-lg p-3 text-sm">
              Total: <span className="font-semibold">{totalSelected} cyl</span> from {selectedIds.size} row(s)
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
              <Button
                onClick={() =>
                  createBatchMut.mutate({
                    corporationName: corpName,
                    challanNumber: challanNumber || undefined,
                    challanDate: challanDate || undefined,
                    defectiveIds: Array.from(selectedIds),
                    notes: notes || undefined,
                  })
                }
                disabled={createBatchMut.isPending}
                loading={createBatchMut.isPending}
              >
                Record
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
