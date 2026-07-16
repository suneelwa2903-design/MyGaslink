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
import { HiOutlinePlus, HiOutlineTrash, HiOutlineShoppingCart } from 'react-icons/hi2';
import {
  createPurchaseEntrySchema,
  createSourceDistributorSchema,
  type CreatePurchaseEntryInput,
  type CreateSourceDistributorInput,
  localTodayISO,
} from '@gaslink/shared';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { Button, Input, Loader, EmptyState, Modal } from '@/components/ui';
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
}

interface PurchaseEntriesListResponse {
  purchaseEntries: PurchaseEntry[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

// ─── Page ────────────────────────────────────────────────────────────────────

type Tab = 'entries' | 'sources';

export default function PurchasesPage() {
  const [tab, setTab] = useState<Tab>('entries');
  const [newEntryOpen, setNewEntryOpen] = useState(false);

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
          <Button onClick={() => setNewEntryOpen(true)}>
            <HiOutlinePlus className="h-4 w-4" />
            New Purchase Entry
          </Button>
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

      {tab === 'entries' ? <EntriesTab /> : <SourcesTab />}

      {newEntryOpen && (
        <NewPurchaseEntryModal
          open={newEntryOpen}
          onClose={() => setNewEntryOpen(false)}
        />
      )}
    </div>
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

function EntriesTab() {
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
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const fullsIn = row.items.reduce((n, i) => n + i.fullsReceived, 0);
              const emptiesOut = row.items.reduce((n, i) => n + i.emptiesGivenOut, 0);
              return (
                <tr key={row.id}>
                  <td className="font-mono text-sm">{row.purchaseNumber}</td>
                  <td>{row.purchaseDate}</td>
                  <td>{row.sourceDistributorName ?? '—'}</td>
                  <td className="text-right">{fullsIn}</td>
                  <td className="text-right">{emptiesOut}</td>
                  <td className="text-sm text-surface-500 dark:text-surface-400">
                    {row.notes ?? '—'}
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

// ─── New purchase entry modal ────────────────────────────────────────────────

type NewPurchaseEntryFormValues = CreatePurchaseEntryInput;

function NewPurchaseEntryModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const { data: sources } = useQuery({
    queryKey: ['source-distributors'],
    queryFn: () => apiGet<SourceDistributor[]>('/source-distributors'),
  });
  const { data: types } = useQuery({
    queryKey: ['cylinder-types'],
    queryFn: () => apiGet<CylinderType[]>('/cylinder-types'),
  });

  const activeTypes = useMemo(
    () => (types ?? []).filter((t) => t.isActive),
    [types],
  );

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<NewPurchaseEntryFormValues>({
    resolver: zodResolver(createPurchaseEntrySchema),
    defaultValues: {
      purchaseDate: localTodayISO(),
      notes: '',
      items: [{ cylinderTypeId: '', fullsReceived: 0, emptiesGivenOut: 0 }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  const createMutation = useMutation({
    mutationFn: (payload: NewPurchaseEntryFormValues) =>
      apiPost<PurchaseEntry>('/purchase-entries', payload),
    onSuccess: (created) => {
      toast.success(`Purchase entry ${created.purchaseNumber} recorded`);
      queryClient.invalidateQueries({ queryKey: ['purchase-entries'] });
      queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
      reset();
      onClose();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <Modal open={open} onClose={onClose} title="New Purchase Entry" size="lg">
      <form
        onSubmit={handleSubmit((v) =>
          createMutation.mutate({
            ...v,
            // Cast fullsReceived / emptiesGivenOut from potential string inputs.
            items: v.items.map((i) => ({
              cylinderTypeId: i.cylinderTypeId,
              fullsReceived: Number(i.fullsReceived) || 0,
              emptiesGivenOut: Number(i.emptiesGivenOut) || 0,
            })),
          }),
        )}
        className="space-y-4"
      >
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
              <p className="mt-1 text-xs text-red-500">
                {errors.purchaseDate.message}
              </p>
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
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
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
                append({ cylinderTypeId: '', fullsReceived: 0, emptiesGivenOut: 0 })
              }
            >
              <HiOutlinePlus className="h-4 w-4" />
              Add Line
            </Button>
          </div>
          <div className="space-y-2">
            {fields.map((f, i) => (
              <div key={f.id} className="grid grid-cols-12 gap-2 items-end">
                <div className="col-span-6">
                  <select
                    aria-label="Cylinder type"
                    className="input"
                    {...register(`items.${i}.cylinderTypeId` as const)}
                  >
                    <option value="">Select cylinder…</option>
                    {activeTypes.map((t) => (
                      <option key={t.cylinderTypeId} value={t.cylinderTypeId}>
                        {t.typeName}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2">
                  <input
                    aria-label="Fulls received"
                    type="number"
                    min={0}
                    placeholder="Fulls"
                    className="input"
                    {...register(`items.${i}.fullsReceived` as const, {
                      valueAsNumber: true,
                    })}
                  />
                </div>
                <div className="col-span-2">
                  <input
                    aria-label="Empties given out"
                    type="number"
                    min={0}
                    placeholder="Empties"
                    className="input"
                    {...register(`items.${i}.emptiesGivenOut` as const, {
                      valueAsNumber: true,
                    })}
                  />
                </div>
                <div className="col-span-2 flex">
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
            ))}
          </div>
          {errors.items && (
            <p className="mt-1 text-xs text-red-500">
              {errors.items.message ?? 'Check the item lines above'}
            </p>
          )}
        </div>

        <div>
          <Input label="Notes (optional)" {...register('notes')} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={createMutation.isPending}>
            Record Purchase
          </Button>
        </div>
      </form>
    </Modal>
  );
}
