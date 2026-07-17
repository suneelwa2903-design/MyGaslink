/**
 * Mini-Operator (2026-07-16) — Purchases page.
 *
 * Route: /app/purchases. Only mini_operator_admin (and super_admin, via
 * requireRole bypass) reach this page — the sidebar hides it for every
 * other role and the ProtectedRoute wrapper enforces the same.
 *
 * Two tabs:
 *   • Purchase Entries — paginated list + "New Purchase Entry" modal.
 *   • Source Distributors — free-text supplier list + inline add form.
 *
 * Wire shapes match the API responses from
 *   GET  /api/source-distributors             → SourceDistributor[]
 *   POST /api/source-distributors             → SourceDistributor
 *   GET  /api/purchase-entries?page&pageSize  → { purchaseEntries, meta }
 *   POST /api/purchase-entries                → PurchaseEntry
 *   GET  /api/cylinder-types                  → CylinderType[]
 */
import { useMemo, useState } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlineTrash,
  HiOutlineShoppingCart,
  HiOutlineArrowDownTray,
} from 'react-icons/hi2';
import {
  createPurchaseEntrySchema,
  createSourceDistributorSchema,
  type CreatePurchaseEntryInput,
  type CreateSourceDistributorInput,
  localTodayISO,
  localDateISO,
} from '@gaslink/shared';
import { api, apiGet, apiPost, apiPut, getErrorMessage } from '@/lib/api';
import { Button, Input, Loader, EmptyState, Modal, Select } from '@/components/ui';
import { cn } from '@/lib/cn';

// ─── Wire types ─────────────────────────────────────────────────────────────

interface SourceDistributor {
  id: string;
  distributorId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface PurchaseEntryItem {
  id: string;
  purchaseEntryId: string;
  cylinderTypeId: string;
  fullsReceived: number;
  emptiesGivenOut: number;
  // Decimal comes over the wire as a string; consumers must coerce with
  // Number() before doing math. Optional to stay backwards-compatible with
  // pre-migration payloads observed in the test suite.
  unitPrice?: number | string;
  cylinderType?: { id: string; typeName: string } | null;
}

interface PurchaseEntry {
  id: string;
  purchaseNumber: string;
  distributorId: string;
  sourceDistributorId: string | null;
  sourceDistributorName: string | null;
  purchaseDate: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  items: PurchaseEntryItem[];
}

interface CylinderType {
  cylinderTypeId: string;
  typeName: string;
  capacity: number;
  unit: string;
  isActive: boolean;
  // Provider catalog row that this per-tenant type was imported from.
  // Nullable — legacy custom-only types have no catalog link. Used to
  // render "HPCL 19KG Commercial" in the purchase-entry dropdown.
  providerCatalog?: {
    providerCode: string;
    shortName: string;
    weight: number;
  } | null;
}

interface CylinderTypesListResponse {
  cylinderTypes: CylinderType[];
}

interface PurchaseEntriesListResponse {
  purchaseEntries: PurchaseEntry[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

// ─── Page ────────────────────────────────────────────────────────────────────

type Tab = 'entries' | 'sources';

// Shared formatter for the INR amounts we render in the entries table and
// edit modal. Uses the same en-IN grouping as the ledger PDF for parity.
const formatINR = (n: number): string =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PurchasesPage() {
  const [tab, setTab] = useState<Tab>('entries');
  const [newEntryOpen, setNewEntryOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [editing, setEditing] = useState<PurchaseEntry | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">
            Purchases
          </h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
            Record stock received from source distributors + manage your supplier list.
          </p>
        </div>
        {tab === 'entries' && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setLedgerOpen(true)}>
              <HiOutlineArrowDownTray className="h-4 w-4" />
              Download Ledger
            </Button>
            <Button onClick={() => setNewEntryOpen(true)}>
              <HiOutlinePlus className="h-4 w-4" />
              New Purchase Entry
            </Button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-surface-200 dark:border-surface-800">
        <nav className="-mb-px flex gap-6">
          <TabButton active={tab === 'entries'} onClick={() => setTab('entries')}>
            Purchase Entries
          </TabButton>
          <TabButton active={tab === 'sources'} onClick={() => setTab('sources')}>
            Source Distributors
          </TabButton>
        </nav>
      </div>

      {tab === 'entries' ? <EntriesTab onEdit={setEditing} /> : <SourcesTab />}

      {newEntryOpen && (
        <PurchaseEntryModal
          mode="create"
          open={newEntryOpen}
          onClose={() => setNewEntryOpen(false)}
        />
      )}

      {editing && (
        <PurchaseEntryModal
          mode="edit"
          entry={editing}
          open={!!editing}
          onClose={() => setEditing(null)}
        />
      )}

      {ledgerOpen && (
        <DownloadLedgerModal
          open={ledgerOpen}
          onClose={() => setLedgerOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Download Ledger modal ───────────────────────────────────────────────────
//
// Backend: GET /api/purchase-entries/ledger.pdf with query params from/to/
// sourceDistributorId/cylinderTypeId. Returns application/pdf. We fetch via
// the shared axios instance (JWT + X-Distributor-Id are injected there) and
// hand the blob to a download anchor. Same pattern as customer-statement PDF
// download in CustomersPage.

function DownloadLedgerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return localDateISO(d);
  });
  const [to, setTo] = useState(() => localTodayISO());
  const [sourceDistributorId, setSourceDistributorId] = useState<string>('');
  const [cylinderTypeId, setCylinderTypeId] = useState<string>('');
  const [downloading, setDownloading] = useState(false);

  const { data: sources } = useQuery({
    queryKey: ['source-distributors'],
    queryFn: () => apiGet<SourceDistributor[]>('/source-distributors'),
  });
  const { data: typeResponse } = useQuery({
    queryKey: ['cylinder-types'],
    queryFn: () => apiGet<CylinderTypesListResponse>('/cylinder-types'),
  });
  const types = typeResponse?.cylinderTypes ?? [];

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const params: Record<string, string> = { from, to };
      if (sourceDistributorId) params.sourceDistributorId = sourceDistributorId;
      if (cylinderTypeId) params.cylinderTypeId = cylinderTypeId;
      const resp = await api.get('/purchase-entries/ledger.pdf', {
        params,
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `purchase-ledger-${from}-${to}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Download Purchase Ledger" size="md">
      <div className="space-y-4">
        <p className="text-sm text-surface-600 dark:text-surface-300">
          Choose a date range and optionally narrow by source distributor or cylinder type.
          The PDF lists every purchase entry line in the window.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Input
            type="date"
            label="From"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <Input
            type="date"
            label="To"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <Select
          label="Source Distributor (optional)"
          value={sourceDistributorId}
          onChange={(e) => setSourceDistributorId(e.target.value)}
          options={[
            { value: '', label: 'All source distributors' },
            ...(sources ?? []).map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
        <Select
          label="Cylinder Type (optional)"
          value={cylinderTypeId}
          onChange={(e) => setCylinderTypeId(e.target.value)}
          options={[
            { value: '', label: 'All cylinder types' },
            ...types.map((t) => ({ value: t.cylinderTypeId, label: t.typeName })),
          ]}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleDownload} loading={downloading}>
            <HiOutlineArrowDownTray className="h-4 w-4" />
            Download PDF
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'py-3 px-1 text-sm font-medium border-b-2 -mb-px transition-colors',
        active
          ? 'border-brand-500 text-brand-600 dark:text-brand-400'
          : 'border-transparent text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200',
      )}
    >
      {children}
    </button>
  );
}

// ─── Entries tab ─────────────────────────────────────────────────────────────

function EntriesTab({ onEdit }: { onEdit: (entry: PurchaseEntry) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['purchase-entries', { page: 1, pageSize: 50 }],
    queryFn: () =>
      apiGet<PurchaseEntriesListResponse>('/purchase-entries', {
        page: 1,
        pageSize: 50,
      }),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader size="lg" />
      </div>
    );
  }

  const rows = data?.purchaseEntries ?? [];

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<HiOutlineShoppingCart className="h-8 w-8" />}
        title="No purchase entries yet"
        description="Record your first stock-in from a source distributor using the button above."
        className="py-16"
      />
    );
  }

  return (
    <div className="card">
      <div className="table-container">
        <table className="table">
          <thead>
            <tr>
              <th>Purchase #</th>
              <th>Date</th>
              <th>Source</th>
              <th className="text-right">Fulls In</th>
              <th className="text-right">Empties Out</th>
              <th className="text-right">Amount</th>
              <th>Notes</th>
              <th className="w-16"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const fullsIn = row.items.reduce((n, i) => n + i.fullsReceived, 0);
              const emptiesOut = row.items.reduce((n, i) => n + i.emptiesGivenOut, 0);
              // unitPrice may arrive as Decimal-serialized-string; coerce.
              const amount = row.items.reduce(
                (n, i) => n + i.fullsReceived * Number(i.unitPrice ?? 0),
                0,
              );
              return (
                <tr key={row.id}>
                  <td className="font-mono text-sm">{row.purchaseNumber}</td>
                  <td>{row.purchaseDate}</td>
                  <td>{row.sourceDistributorName ?? '—'}</td>
                  <td className="text-right">{fullsIn}</td>
                  <td className="text-right">{emptiesOut}</td>
                  <td className="text-right font-medium">
                    {amount > 0 ? formatINR(amount) : '—'}
                  </td>
                  <td className="text-sm text-surface-500 dark:text-surface-400">
                    {row.notes ?? '—'}
                  </td>
                  <td className="text-right">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => onEdit(row)}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Sources tab ─────────────────────────────────────────────────────────────

function SourcesTab() {
  const queryClient = useQueryClient();
  const { data: sources, isLoading } = useQuery({
    queryKey: ['source-distributors'],
    queryFn: () => apiGet<SourceDistributor[]>('/source-distributors'),
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateSourceDistributorInput>({
    resolver: zodResolver(createSourceDistributorSchema),
    defaultValues: { name: '' },
  });

  const createMutation = useMutation({
    mutationFn: (payload: CreateSourceDistributorInput) =>
      apiPost<SourceDistributor>('/source-distributors', payload),
    onSuccess: () => {
      toast.success('Source distributor added');
      queryClient.invalidateQueries({ queryKey: ['source-distributors'] });
      reset({ name: '' });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <div className="space-y-4">
      <form
        onSubmit={handleSubmit((v) => createMutation.mutate(v))}
        className="card p-4 flex gap-3 items-end"
      >
        <div className="flex-1">
          <Input
            label="Add Source Distributor"
            placeholder="e.g. Sharma Gas Distributors"
            error={errors.name?.message}
            {...register('name')}
          />
        </div>
        <Button type="submit" loading={createMutation.isPending}>
          <HiOutlinePlus className="h-4 w-4" />
          Add
        </Button>
      </form>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader />
        </div>
      ) : !sources || sources.length === 0 ? (
        <EmptyState
          title="No source distributors yet"
          description="Add the LPG distributors you buy stock from so you can pick them on each purchase entry."
          className="py-16"
        />
      ) : (
        <div className="card">
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id}>
                    <td className="font-medium">{s.name}</td>
                    <td className="text-sm text-surface-500 dark:text-surface-400">
                      {s.createdAt.split('T')[0]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Purchase entry modal (create + edit) ────────────────────────────────────

// `z.default()` on unitPrice makes zod's INPUT type diverge from its OUTPUT
// (input keeps unitPrice optional; output guarantees it). react-hook-form
// resolves to the INPUT type — align our form values to that so the
// defaultValues + register calls type-check cleanly.
type PurchaseEntryFormItem = {
  cylinderTypeId: string;
  fullsReceived: number;
  emptiesGivenOut: number;
  unitPrice?: number;
};
type PurchaseEntryFormValues = Omit<CreatePurchaseEntryInput, 'items'> & {
  items: PurchaseEntryFormItem[];
};

interface PurchaseEntryModalProps {
  open: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  entry?: PurchaseEntry;
}

function PurchaseEntryModal({ open, onClose, mode, entry }: PurchaseEntryModalProps) {
  const queryClient = useQueryClient();
  const isEdit = mode === 'edit' && !!entry;

  const { data: sources } = useQuery({
    queryKey: ['source-distributors'],
    queryFn: () => apiGet<SourceDistributor[]>('/source-distributors'),
  });
  const { data: typesResponse } = useQuery({
    queryKey: ['cylinder-types'],
    queryFn: () => apiGet<CylinderTypesListResponse>('/cylinder-types'),
  });

  const activeTypes = useMemo(
    () => (typesResponse?.cylinderTypes ?? []).filter((t) => t.isActive),
    [typesResponse],
  );

  const initialItems = useMemo<PurchaseEntryFormItem[]>(() => {
    if (isEdit && entry) {
      return entry.items.map((i) => ({
        cylinderTypeId: i.cylinderTypeId,
        fullsReceived: i.fullsReceived,
        emptiesGivenOut: i.emptiesGivenOut,
        unitPrice: Number(i.unitPrice ?? 0),
      }));
    }
    return [
      { cylinderTypeId: '', fullsReceived: 0, emptiesGivenOut: 0, unitPrice: 0 },
    ];
  }, [isEdit, entry]);

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors },
  } = useForm<PurchaseEntryFormValues>({
    resolver: zodResolver(createPurchaseEntrySchema),
    defaultValues: {
      purchaseDate: entry?.purchaseDate ?? localTodayISO(),
      notes: entry?.notes ?? '',
      sourceDistributorId: entry?.sourceDistributorId ?? undefined,
      items: initialItems,
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  // Live-computed grand total for the entry — shows the reseller what the
  // whole purchase adds up to as they type.
  const watchedItems = watch('items');
  const grandTotal = (watchedItems ?? []).reduce(
    (n, i) => n + (Number(i.fullsReceived) || 0) * (Number(i.unitPrice) || 0),
    0,
  );

  const mutation = useMutation({
    mutationFn: (payload: PurchaseEntryFormValues) => {
      const normalized = {
        ...payload,
        items: payload.items.map((i) => ({
          cylinderTypeId: i.cylinderTypeId,
          fullsReceived: Number(i.fullsReceived) || 0,
          emptiesGivenOut: Number(i.emptiesGivenOut) || 0,
          unitPrice: Number(i.unitPrice) || 0,
        })),
      };
      return isEdit && entry
        ? apiPut<PurchaseEntry>(`/purchase-entries/${entry.id}`, normalized)
        : apiPost<PurchaseEntry>('/purchase-entries', normalized);
    },
    onSuccess: (result) => {
      toast.success(
        isEdit
          ? `Purchase entry ${result.purchaseNumber} updated`
          : `Purchase entry ${result.purchaseNumber} recorded`,
      );
      queryClient.invalidateQueries({ queryKey: ['purchase-entries'] });
      queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
      reset();
      onClose();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit Purchase Entry ${entry?.purchaseNumber ?? ''}` : 'New Purchase Entry'}
      size="lg"
    >
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="purchaseDate"
              className="mb-1 block text-sm font-medium text-surface-700 dark:text-surface-300"
            >
              Purchase Date
            </label>
            <input
              id="purchaseDate"
              type="date"
              className="input"
              {...register('purchaseDate')}
            />
            {errors.purchaseDate && (
              <p className="mt-1 text-xs text-red-500">{errors.purchaseDate.message}</p>
            )}
          </div>
          <div>
            <label
              htmlFor="sourceDistributorId"
              className="mb-1 block text-sm font-medium text-surface-700 dark:text-surface-300"
            >
              Source Distributor
            </label>
            <select
              id="sourceDistributorId"
              className="input"
              {...register('sourceDistributorId')}
            >
              <option value="">— optional —</option>
              {sources?.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-surface-700 dark:text-surface-300">
              Items
            </label>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                append({ cylinderTypeId: '', fullsReceived: 0, emptiesGivenOut: 0, unitPrice: 0 })
              }
            >
              <HiOutlinePlus className="h-4 w-4" />
              Add Line
            </Button>
          </div>
          {/* Column headers so users understand the compact number fields. */}
          <div className="grid grid-cols-12 gap-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-surface-500 dark:text-surface-400">
            <div className="col-span-4">Cylinder</div>
            <div className="col-span-2 text-right">Fulls</div>
            <div className="col-span-2 text-right">Empties</div>
            <div className="col-span-2 text-right">Unit ₹</div>
            <div className="col-span-1 text-right">Amount</div>
            <div className="col-span-1"></div>
          </div>
          <div className="space-y-2">
            {fields.map((f, i) => {
              const wf = Number(watchedItems?.[i]?.fullsReceived) || 0;
              const wp = Number(watchedItems?.[i]?.unitPrice) || 0;
              const lineTotal = wf * wp;
              return (
                <div key={f.id} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-4">
                    <select
                      aria-label="Cylinder type"
                      className="input"
                      {...register(`items.${i}.cylinderTypeId` as const)}
                    >
                      <option value="">Select cylinder…</option>
                      {activeTypes.map((t) => {
                        const label = t.providerCatalog?.providerCode
                          ? `${t.providerCatalog.providerCode} — ${t.typeName}`
                          : t.typeName;
                        return (
                          <option key={t.cylinderTypeId} value={t.cylinderTypeId}>
                            {label}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <input
                      aria-label="Fulls received"
                      type="number"
                      min={0}
                      placeholder="Fulls"
                      className="input text-right"
                      {...register(`items.${i}.fullsReceived` as const, { valueAsNumber: true })}
                    />
                  </div>
                  <div className="col-span-2">
                    <input
                      aria-label="Empties given out"
                      type="number"
                      min={0}
                      placeholder="Empties"
                      className="input text-right"
                      {...register(`items.${i}.emptiesGivenOut` as const, { valueAsNumber: true })}
                    />
                  </div>
                  <div className="col-span-2">
                    <input
                      aria-label="Unit price"
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="0.00"
                      className="input text-right"
                      {...register(`items.${i}.unitPrice` as const, { valueAsNumber: true })}
                    />
                  </div>
                  <div className="col-span-1 text-right text-sm font-medium text-surface-700 dark:text-surface-300 tabular-nums">
                    {lineTotal > 0 ? formatINR(lineTotal) : '—'}
                  </div>
                  <div className="col-span-1 flex justify-end">
                    {fields.length > 1 && (
                      <button
                        type="button"
                        onClick={() => remove(i)}
                        className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                        aria-label="Remove line"
                      >
                        <HiOutlineTrash className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {errors.items && (
            <p className="mt-1 text-xs text-red-500">
              {errors.items.message ?? 'Check the item lines above'}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between rounded-md bg-surface-50 dark:bg-surface-900 px-4 py-3">
          <div className="text-sm text-surface-500 dark:text-surface-400">Total amount</div>
          <div className="text-lg font-semibold text-surface-900 dark:text-white tabular-nums">
            {grandTotal > 0 ? formatINR(grandTotal) : '—'}
          </div>
        </div>

        <div>
          <Input label="Notes (optional)" {...register('notes')} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            {isEdit ? 'Save Changes' : 'Record Purchase'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
