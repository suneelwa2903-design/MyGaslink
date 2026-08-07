/**
 * Mini-op #5 v2 (2026-07-27 evening) — Expenses page.
 *
 * Route: /app/expenses. Available to distributor_admin / finance /
 * mini_operator_admin / super_admin. Consumes tenant-owned expense
 * taxonomy from GET /api/expense-categories — no hard-coded categories
 * left in the client. Progressive-reveal form config is driven by the
 * selected leaf's own showVehicle / vendorLabel / etc. columns.
 */
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { HiOutlinePlus, HiOutlinePencil, HiOutlineTrash, HiOutlineArrowDownTray } from 'react-icons/hi2';
import {
  createExpenseSchema,
  EXPENSE_PAYMENT_METHODS,
  localTodayISO,
  type CreateExpenseInput,
  type Expense,
  type ExpenseCategory,
  type ExpenseSummary,
} from '@gaslink/shared';
import { api, apiGet, apiPost, apiPut, apiDelete, getErrorMessage } from '@/lib/api';
import { Button, Input, Loader, EmptyState, Modal, Select } from '@/components/ui';

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Cash',
  cheque: 'Cheque',
  online: 'Online',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  credit: 'Credit',
};

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

interface Vehicle { id: string; vehicleNumber: string }
interface Driver { id: string; driverName: string }
interface ExpensesListResponse { expenses: Expense[]; meta: { page: number; pageSize: number; total: number; pageCount: number } }
interface CategoriesResponse { categories: ExpenseCategory[] }

// ─── Category-tree helpers ───────────────────────────────────────────────

/** Grouped picker options — headers as optgroup labels, leaves as options.
 * Only active + non-header categories are selectable. */
interface GroupedOption { headerName: string; leaves: { id: string; name: string }[] }

function buildGroupedOptions(categories: ExpenseCategory[]): GroupedOption[] {
  const active = categories.filter((c) => c.isActive);
  const headers = active.filter((c) => c.isHeader).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const leavesByParent = new Map<string, ExpenseCategory[]>();
  const orphans: ExpenseCategory[] = [];
  for (const c of active) {
    if (c.isHeader) continue;
    if (c.parentId) {
      const arr = leavesByParent.get(c.parentId) ?? [];
      arr.push(c);
      leavesByParent.set(c.parentId, arr);
    } else {
      orphans.push(c);
    }
  }
  const groups: GroupedOption[] = headers.map((h) => ({
    headerName: h.name,
    leaves: (leavesByParent.get(h.categoryId) ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((c) => ({ id: c.categoryId, name: c.name })),
  })).filter((g) => g.leaves.length > 0);
  if (orphans.length > 0) {
    groups.push({
      headerName: 'Uncategorised',
      leaves: orphans
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .map((c) => ({ id: c.categoryId, name: c.name })),
    });
  }
  return groups;
}

/** Native <select> with <optgroup> support — the shared Select component
 * only understands flat options, so we render a raw select here. */
function GroupedCategorySelect({
  label, value, onChange, groups, required, includeAllOption, allOptionLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  groups: GroupedOption[];
  required?: boolean;
  includeAllOption?: boolean;
  allOptionLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label className="text-sm font-medium text-surface-700 dark:text-surface-200">
          {label}{required && ' *'}
        </label>
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="rounded-md border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 px-3 py-2 text-sm text-surface-900 dark:text-white focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
      >
        {includeAllOption && <option value="">{allOptionLabel ?? 'All categories'}</option>}
        {!includeAllOption && !required && <option value="">— select —</option>}
        {groups.map((g) => (
          <optgroup key={g.headerName} label={g.headerName}>
            {g.leaves.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────

export default function ExpensesPage() {
  const queryClient = useQueryClient();
  const today = localTodayISO();
  const monthStart = today.slice(0, 8) + '01';
  const [from, setFrom] = useState<string>(monthStart);
  const [to, setTo] = useState<string>(today);
  const [categoryId, setCategoryId] = useState<string>('');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [downloadOpen, setDownloadOpen] = useState(false);

  const categoriesQuery = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => apiGet<CategoriesResponse>('/expense-categories'),
  });
  // 2026-08-06: memoise fallback so downstream useMemo doesn't re-run every render.
  const categories = useMemo(() => categoriesQuery.data?.categories ?? [], [categoriesQuery.data?.categories]);
  const groupedOptions = useMemo(() => buildGroupedOptions(categories), [categories]);

  const listQuery = useQuery({
    queryKey: ['expenses', from, to, categoryId, page],
    queryFn: () => apiGet<ExpensesListResponse>('/expenses', {
      from, to,
      ...(categoryId ? { categoryId } : {}),
      page, pageSize: 25,
    }),
  });
  const summaryQuery = useQuery({
    queryKey: ['expenses-summary', from, to],
    queryFn: () => apiGet<ExpenseSummary>('/expenses/summary', { from, to }),
  });
  const vehiclesQuery = useQuery({
    queryKey: ['vehicles-for-expense'],
    queryFn: () => apiGet<{ vehicles: Vehicle[] }>('/vehicles'),
  });
  const driversQuery = useQuery({
    queryKey: ['drivers-for-expense'],
    queryFn: () => apiGet<{ drivers: Driver[] }>('/drivers'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/expenses/${id}`),
    onSuccess: () => {
      toast.success('Expense deleted');
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['expenses-summary'] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const topCategories = useMemo(
    () => (summaryQuery.data?.byCategory ?? []).slice(0, 3),
    [summaryQuery.data],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Expenses</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400">
            Track operational spend outside of cylinder purchases
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setDownloadOpen(true)}>
            <HiOutlineArrowDownTray className="h-4 w-4" />
            Download report
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <HiOutlinePlus className="h-4 w-4" />
            Record expense
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
        <Input label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
        <Input label="To" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
        <GroupedCategorySelect
          label="Category"
          value={categoryId}
          onChange={(v) => { setCategoryId(v); setPage(1); }}
          groups={groupedOptions}
          includeAllOption
          allOptionLabel="All categories"
        />
        <div className="text-right text-xs text-surface-500 dark:text-surface-400">
          {summaryQuery.data && `${summaryQuery.data.count} entries · ${inr.format(summaryQuery.data.totalAmount)}`}
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="card p-4">
          <div className="text-xs text-surface-500 dark:text-surface-400">Total spent</div>
          <div className="mt-1 text-2xl font-bold text-surface-900 dark:text-white">
            {summaryQuery.data ? inr.format(summaryQuery.data.totalAmount) : '—'}
          </div>
        </div>
        {topCategories.map((c) => (
          <div key={c.categoryId} className="card p-4">
            <div className="text-xs text-surface-500 dark:text-surface-400">
              {c.parentName ? `${c.parentName} / ${c.categoryName}` : c.categoryName}
            </div>
            <div className="mt-1 text-2xl font-bold text-surface-900 dark:text-white">
              {inr.format(c.amount)}
            </div>
            <div className="mt-0.5 text-xs text-surface-400">{c.count} entries</div>
          </div>
        ))}
        {topCategories.length === 0 && summaryQuery.data && (
          <div className="card p-4 sm:col-span-3 text-sm text-surface-400 italic">
            No expenses in this window yet.
          </div>
        )}
      </div>

      {/* Table */}
      {listQuery.isLoading ? (
        <div className="flex justify-center py-16"><Loader /></div>
      ) : !listQuery.data || listQuery.data.expenses.length === 0 ? (
        <EmptyState
          title="No expenses in this window"
          description="Adjust the date range or click Record expense to add your first entry."
          className="py-16"
        />
      ) : (
        <div className="card">
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Description</th>
                  <th>Method</th>
                  <th>Vehicle / Driver</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {listQuery.data.expenses.map((e) => (
                  <tr key={e.expenseId}>
                    <td className="whitespace-nowrap">{e.expenseDate}</td>
                    <td title={e.categoryPath}>{e.categoryName}</td>
                    <td className="max-w-xs truncate" title={e.description}>{e.description}</td>
                    <td>{PAYMENT_LABELS[e.paymentMethod] ?? e.paymentMethod}</td>
                    <td className="text-sm text-surface-500 dark:text-surface-400">
                      {[e.vehicleNumber, e.driverName].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="text-right font-medium">{inr.format(e.amount)}</td>
                    <td className="text-right">
                      <div className="inline-flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(e)} title="Edit">
                          <HiOutlinePencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (window.confirm('Delete this expense?')) deleteMutation.mutate(e.expenseId);
                          }}
                          title="Delete"
                        >
                          <HiOutlineTrash className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {listQuery.data.meta.pageCount > 1 && (
            <div className="flex justify-between items-center p-3 text-sm">
              <Button variant="ghost" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Prev</Button>
              <span>Page {page} of {listQuery.data.meta.pageCount}</span>
              <Button variant="ghost" size="sm" disabled={page >= listQuery.data.meta.pageCount} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          )}
        </div>
      )}

      {createOpen && (
        <ExpenseFormModal
          mode="create"
          categories={categories}
          groups={groupedOptions}
          vehicles={vehiclesQuery.data?.vehicles ?? []}
          drivers={driversQuery.data?.drivers ?? []}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['expenses'] });
            queryClient.invalidateQueries({ queryKey: ['expenses-summary'] });
            setCreateOpen(false);
          }}
        />
      )}

      {editing && (
        <ExpenseFormModal
          mode="edit"
          expense={editing}
          categories={categories}
          groups={groupedOptions}
          vehicles={vehiclesQuery.data?.vehicles ?? []}
          drivers={driversQuery.data?.drivers ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['expenses'] });
            queryClient.invalidateQueries({ queryKey: ['expenses-summary'] });
            setEditing(null);
          }}
        />
      )}

      {downloadOpen && (
        <DownloadReportModal
          defaultFrom={from}
          defaultTo={to}
          categories={categories}
          groups={groupedOptions}
          onClose={() => setDownloadOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Download report modal ─────────────────────────────────────────────────

function DownloadReportModal({
  defaultFrom, defaultTo, categories, groups, onClose,
}: {
  defaultFrom: string;
  defaultTo: string;
  categories: ExpenseCategory[];
  groups: GroupedOption[];
  onClose: () => void;
}) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [scope, setScope] = useState<'consolidated' | 'header' | 'leaf'>('consolidated');
  const headers = useMemo(
    () => categories.filter((c) => c.isHeader && c.isActive).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [categories],
  );
  const [headerId, setHeaderId] = useState<string>(headers[0]?.categoryId ?? '');
  const [categoryId, setCategoryId] = useState<string>(groups[0]?.leaves[0]?.id ?? '');
  const [downloading, setDownloading] = useState(false);

  // Reset defaults once categories load.
  /* eslint-disable react-hooks/set-state-in-effect --
   * Init-once picker defaults after the categories query resolves.
   * Guarded by the `!headerId` / `!categoryId` checks so it fires
   * exactly once (idempotent) when data first lands.
   */
  useEffect(() => {
    if (!headerId && headers[0]) setHeaderId(headers[0].categoryId);
    if (!categoryId && groups[0]?.leaves[0]) setCategoryId(groups[0].leaves[0].id);
  }, [headers, groups, headerId, categoryId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const params: Record<string, string> = { from, to };
      if (scope === 'header') params.headerId = headerId;
      if (scope === 'leaf') params.categoryId = categoryId;
      const resp = await api.get('/expenses/report/pdf', { params, responseType: 'blob' });
      const url = window.URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url;
      const suffix = scope === 'leaf'
        ? categories.find((c) => c.categoryId === categoryId)?.code ?? 'category'
        : scope === 'header'
          ? categories.find((c) => c.categoryId === headerId)?.code ?? 'header'
          : 'consolidated';
      a.download = `expense-report-${suffix}-${from}-to-${to}.pdf`;
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
    <Modal open onClose={onClose} title="Download expense report" size="md">
      <div className="space-y-4">
        <p className="text-sm text-surface-600 dark:text-surface-300">
          Management report — for statutory filings consult your CA.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-surface-700 dark:text-surface-200">Report type</label>
          <div className="flex flex-col gap-2">
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="scope" value="consolidated"
                checked={scope === 'consolidated'} onChange={() => setScope('consolidated')} className="mt-1" />
              <div>
                <div className="font-medium">Consolidated (all categories)</div>
                <div className="text-xs text-surface-500 dark:text-surface-400">
                  Grouped by header with per-leaf subtotals, header totals, and a grand total
                </div>
              </div>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="scope" value="header"
                checked={scope === 'header'} onChange={() => setScope('header')} className="mt-1" />
              <div className="flex-1">
                <div className="font-medium">One header (all its subcategories)</div>
                <div className="text-xs text-surface-500 dark:text-surface-400 mb-2">
                  e.g. all &ldquo;Vehicle Costs&rdquo; leaves with per-leaf subtotals
                </div>
                {scope === 'header' && (
                  <Select
                    label=""
                    value={headerId}
                    onChange={(e) => setHeaderId(e.target.value)}
                    options={headers.map((h) => ({ value: h.categoryId, label: h.name }))}
                  />
                )}
              </div>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="scope" value="leaf"
                checked={scope === 'leaf'} onChange={() => setScope('leaf')} className="mt-1" />
              <div className="flex-1">
                <div className="font-medium">Single category (leaf)</div>
                <div className="text-xs text-surface-500 dark:text-surface-400 mb-2">
                  Flat table filtered to one category
                </div>
                {scope === 'leaf' && (
                  <GroupedCategorySelect
                    label=""
                    value={categoryId}
                    onChange={setCategoryId}
                    groups={groups}
                    required
                  />
                )}
              </div>
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-3 pt-3">
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

// ─── Create / Edit modal ────────────────────────────────────────────────────

function ExpenseFormModal({
  mode, expense, categories, groups, vehicles, drivers, onClose, onSaved,
}: {
  mode: 'create' | 'edit';
  expense?: Expense;
  categories: ExpenseCategory[];
  groups: GroupedOption[];
  vehicles: Vehicle[];
  drivers: Driver[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = mode === 'edit' && !!expense;
  const firstLeafId = groups[0]?.leaves[0]?.id ?? '';
  const {
    register, handleSubmit, watch, setValue, formState: { errors },
  } = useForm<CreateExpenseInput>({
    resolver: zodResolver(createExpenseSchema),
    defaultValues: isEdit
      ? {
          expenseDate: expense!.expenseDate,
          categoryId: expense!.categoryId,
          amount: expense!.amount,
          description: expense!.description,
          paymentMethod: expense!.paymentMethod as CreateExpenseInput['paymentMethod'],
          vendorName: expense!.vendorName ?? undefined,
          paidToName: expense!.paidToName ?? undefined,
          vehicleId: expense!.vehicleId ?? undefined,
          driverId: expense!.driverId ?? undefined,
          referenceNumber: expense!.referenceNumber ?? undefined,
          notes: expense!.notes ?? undefined,
        }
      : {
          expenseDate: localTodayISO(),
          categoryId: firstLeafId,
          amount: 0,
          description: '',
          paymentMethod: 'cash',
        },
  });

  // Watch the selected category so we can drive the progressive reveal.
  const currentCategoryId = watch('categoryId');
  const currentCategory = useMemo(
    () => categories.find((c) => c.categoryId === currentCategoryId),
    [categories, currentCategoryId],
  );
  const showVehicle = currentCategory?.showVehicle ?? false;
  const vehicleRequired = currentCategory?.vehicleRequired ?? false;
  const showDriver = currentCategory?.showDriver ?? false;
  const driverRequired = currentCategory?.driverRequired ?? false;
  // v3 (2026-07-27): freeform Paid-to text field, used where the money went
  // to a person NOT in the fleet driver list (helper, loader, landlord,
  // office staff etc.). Enabled per-category via the DB config.
  const showPaidTo = currentCategory?.showPaidTo ?? false;
  const paidToRequired = currentCategory?.paidToRequired ?? false;
  const paidToLabel = currentCategory?.paidToLabel || 'Paid to (optional)';
  const paidToPlaceholder = currentCategory?.paidToPlaceholder || 'Recipient name';
  const vendorLabel = currentCategory?.vendorLabel || 'Vendor (optional)';
  const vendorPlaceholder = currentCategory?.vendorPlaceholder || 'Vendor name';
  const referenceLabel = currentCategory?.referenceLabel || 'Reference # (optional)';
  const referencePlaceholder = currentCategory?.referencePlaceholder || 'Any reference';
  const hint = currentCategory?.hint;

  // Clear vehicle/driver/paid-to when switching to a category that doesn't ask for them.
  useEffect(() => {
    if (!showVehicle) setValue('vehicleId', undefined);
    if (!showDriver) setValue('driverId', undefined);
    if (!showPaidTo) setValue('paidToName', undefined);
  }, [currentCategoryId, showVehicle, showDriver, showPaidTo, setValue]);

  const mutation = useMutation({
    mutationFn: (data: CreateExpenseInput) => {
      // Client-side gate for category-driven required fields. The shared
      // Zod schema treats vehicleId / driverId / paidToName as optional
      // (they only become required when the CATEGORY says so via the
      // showXxx + xxxRequired flags), so react-hook-form's resolver
      // won't catch these. Silent-fail was the symptom: Record clicked
      // → no POST → no toast (scenario test issue #1). Guard here.
      const missing: string[] = [];
      if (showVehicle && vehicleRequired && !data.vehicleId) missing.push('Vehicle');
      if (showDriver && driverRequired && !data.driverId) missing.push('Driver');
      if (showPaidTo && paidToRequired && !data.paidToName?.trim()) missing.push(paidToLabel);
      if (missing.length > 0) {
        toast.error(`Please fill: ${missing.join(', ')}`);
        return Promise.reject(new Error('validation'));
      }

      const clean = {
        ...data,
        vendorName: data.vendorName || undefined,
        paidToName: data.paidToName || undefined,
        vehicleId: data.vehicleId || undefined,
        driverId: data.driverId || undefined,
        referenceNumber: data.referenceNumber || undefined,
        notes: data.notes || undefined,
      };
      return isEdit
        ? apiPut(`/expenses/${expense!.expenseId}`, clean)
        : apiPost('/expenses', clean);
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Expense updated' : 'Expense recorded');
      onSaved();
    },
    onError: (err) => {
      // Suppress the local 'validation' pseudo-error — a toast already fired.
      if ((err as Error).message === 'validation') return;
      toast.error(getErrorMessage(err));
    },
  });

  return (
    <Modal open onClose={onClose} title={isEdit ? 'Edit expense' : 'Record expense'} size="md">
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Date"
            type="date"
            required
            error={errors.expenseDate?.message}
            {...register('expenseDate')}
          />
          <Input
            label="Amount (₹)"
            type="number"
            step="0.01"
            min="0.01"
            required
            error={errors.amount?.message}
            {...register('amount', { valueAsNumber: true })}
          />
        </div>
        <GroupedCategorySelect
          label="Category"
          value={currentCategoryId ?? ''}
          onChange={(v) => setValue('categoryId', v, { shouldValidate: true })}
          groups={groups}
          required
        />
        {errors.categoryId?.message && (
          <p className="text-xs text-red-500 -mt-2">{errors.categoryId.message}</p>
        )}
        <Input
          label="Description"
          required
          placeholder="e.g. Diesel for TS08X1234"
          error={errors.description?.message}
          {...register('description')}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select
            label="Payment method"
            error={errors.paymentMethod?.message}
            {...register('paymentMethod')}
            options={EXPENSE_PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_LABELS[m] ?? m }))}
          />
          <Input
            label={vendorLabel}
            placeholder={vendorPlaceholder}
            {...register('vendorName')}
          />
        </div>
        {hint && <p className="text-xs text-slate-500 dark:text-slate-400 -mt-1">{hint}</p>}
        {showPaidTo && (
          <Input
            label={`${paidToLabel}${paidToRequired ? ' *' : ''}`}
            placeholder={paidToPlaceholder}
            required={paidToRequired}
            {...register('paidToName')}
          />
        )}
        {(showVehicle || showDriver) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {showVehicle && (
              <Select
                label={`Vehicle${vehicleRequired ? '' : ' (optional)'}`}
                {...register('vehicleId')}
                options={[
                  { value: '', label: '—' },
                  ...vehicles.map((v) => ({ value: v.id, label: v.vehicleNumber })),
                ]}
              />
            )}
            {showDriver && (
              <Select
                label={`Driver${driverRequired ? '' : ' (optional)'}`}
                {...register('driverId')}
                options={[
                  { value: '', label: '—' },
                  ...drivers.map((d) => ({ value: d.id, label: d.driverName })),
                ]}
              />
            )}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label={referenceLabel} placeholder={referencePlaceholder} {...register('referenceNumber')} />
          <Input label="Notes (optional)" {...register('notes')} />
        </div>
        <div className="flex justify-end gap-3 pt-3">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>
            {isEdit ? 'Update' : 'Record'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
