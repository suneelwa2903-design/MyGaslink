/**
 * Mini-op #5 (2026-07-27) — Expenses page.
 *
 * Route: /app/expenses. Available to distributor_admin / finance /
 * mini_operator_admin / super_admin (see the ProtectedRoute wrap in
 * routes/index.tsx). Purposely NOT gated to mini-op — regular
 * distributors also need to track operational expenses.
 *
 * Layout:
 *   - Filter row: date range + category dropdown
 *   - Summary strip: 4 tiles (Total, count, top-3 categories rollup)
 *   - Table: paginated list with per-row edit
 *   - Modals: Create + Edit share the same body
 */
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { HiOutlinePlus, HiOutlinePencil, HiOutlineTrash, HiOutlineArrowDownTray } from 'react-icons/hi2';
import { api } from '@/lib/api';
import {
  createExpenseSchema,
  EXPENSE_CATEGORIES,
  EXPENSE_PAYMENT_METHODS,
  localTodayISO,
  type CreateExpenseInput,
  type Expense,
  type ExpenseSummary,
} from '@gaslink/shared';
import { apiGet, apiPost, apiPut, apiDelete, getErrorMessage } from '@/lib/api';
import { Button, Input, Loader, EmptyState, Modal, Select } from '@/components/ui';

// Per-category field config. Drives progressive reveal in the form: which of
// {Vehicle, Driver} are shown, and what label + placeholder Vendor + Reference
// carry for that category. Kept in ONE place so mobile can re-use identical
// copy later.
type CategoryFieldConfig = {
  showVehicle: boolean;
  vehicleRequired?: boolean;
  showDriver: boolean;
  driverRequired?: boolean;
  vendorLabel: string;
  vendorPlaceholder: string;
  referenceLabel: string;
  referencePlaceholder: string;
  hint?: string;
};

const CATEGORY_FIELDS: Record<string, CategoryFieldConfig> = {
  fuel: {
    showVehicle: true, vehicleRequired: true, showDriver: true,
    vendorLabel: 'Petrol pump', vendorPlaceholder: 'e.g. HP Petrol Pump',
    referenceLabel: 'Bill #', referencePlaceholder: 'From the fuel bill',
  },
  vehicle_maintenance: {
    showVehicle: true, vehicleRequired: true, showDriver: false,
    vendorLabel: 'Service center', vendorPlaceholder: 'e.g. Bosch Service',
    referenceLabel: 'Invoice #', referencePlaceholder: 'From the service invoice',
  },
  salaries_wages: {
    showVehicle: false, showDriver: true,
    vendorLabel: 'Paid to (helper / staff)', vendorPlaceholder: 'e.g. Ravi (helper)',
    referenceLabel: 'Reference #', referencePlaceholder: 'Any receipt / note ID',
    hint: 'Pick a driver from the dropdown for driver salary. For helpers or other staff, type in "Paid to".',
  },
  rent: {
    showVehicle: false, showDriver: false,
    vendorLabel: 'Landlord', vendorPlaceholder: 'Landlord name',
    referenceLabel: 'Receipt #', referencePlaceholder: 'Rent receipt number',
  },
  utilities: {
    showVehicle: false, showDriver: false,
    vendorLabel: 'Provider', vendorPlaceholder: 'e.g. TSSPDCL, Metro Water',
    referenceLabel: 'Bill / account #', referencePlaceholder: 'Utility bill number',
  },
  loading_unloading: {
    showVehicle: false, showDriver: true,
    vendorLabel: 'Labor / vendor', vendorPlaceholder: 'e.g. Ramu (loader)',
    referenceLabel: 'Reference #', referencePlaceholder: 'Any receipt / note ID',
  },
  cylinder_deposits: {
    showVehicle: false, showDriver: false,
    vendorLabel: 'Supplier', vendorPlaceholder: 'e.g. HPCL depot',
    referenceLabel: 'Deposit receipt #', referencePlaceholder: 'From deposit slip',
  },
  office_supplies: {
    showVehicle: false, showDriver: false,
    vendorLabel: 'Store', vendorPlaceholder: 'e.g. Reliance Trends',
    referenceLabel: 'Bill #', referencePlaceholder: 'From the bill',
  },
  communication: {
    showVehicle: false, showDriver: false,
    vendorLabel: 'Provider', vendorPlaceholder: 'e.g. Airtel, Jio',
    referenceLabel: 'Bill / account #', referencePlaceholder: 'Utility bill number',
  },
  insurance: {
    showVehicle: true, showDriver: true,
    vendorLabel: 'Insurer', vendorPlaceholder: 'e.g. Bajaj Allianz',
    referenceLabel: 'Policy #', referencePlaceholder: 'Insurance policy number',
    hint: 'Pick a Vehicle for vehicle insurance, or a Driver for staff health / accident cover.',
  },
  taxes_licenses: {
    showVehicle: false, showDriver: false,
    vendorLabel: 'Department', vendorPlaceholder: 'e.g. GST, RTO',
    referenceLabel: 'Challan #', referencePlaceholder: 'Payment challan / receipt',
  },
  bank_charges: {
    showVehicle: false, showDriver: false,
    vendorLabel: 'Bank', vendorPlaceholder: 'e.g. HDFC, SBI',
    referenceLabel: 'Transaction #', referencePlaceholder: 'Statement reference',
  },
  other: {
    showVehicle: true, showDriver: true,
    vendorLabel: 'Vendor (optional)', vendorPlaceholder: 'Vendor name',
    referenceLabel: 'Reference # (optional)', referencePlaceholder: 'Any reference',
  },
};

const DEFAULT_FIELD_CONFIG: CategoryFieldConfig = CATEGORY_FIELDS.other;

// Human-friendly category labels for the dropdown + summary tiles.
const CATEGORY_LABELS: Record<string, string> = {
  fuel: 'Fuel',
  vehicle_maintenance: 'Vehicle maintenance',
  salaries_wages: 'Salaries & wages',
  rent: 'Rent',
  utilities: 'Utilities',
  loading_unloading: 'Loading / unloading',
  cylinder_deposits: 'Cylinder deposits',
  office_supplies: 'Office supplies',
  communication: 'Communication',
  insurance: 'Insurance',
  taxes_licenses: 'Taxes & licenses',
  bank_charges: 'Bank charges',
  other: 'Other',
};

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

export default function ExpensesPage() {
  const queryClient = useQueryClient();
  // Default to current month.
  const today = localTodayISO();
  const monthStart = today.slice(0, 8) + '01';
  const [from, setFrom] = useState<string>(monthStart);
  const [to, setTo] = useState<string>(today);
  const [category, setCategory] = useState<string>('');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [downloadOpen, setDownloadOpen] = useState(false);

  const listQuery = useQuery({
    queryKey: ['expenses', from, to, category, page],
    queryFn: () => apiGet<ExpensesListResponse>('/expenses', {
      from, to,
      ...(category ? { category } : {}),
      page, pageSize: 25,
    }),
  });
  const summaryQuery = useQuery({
    queryKey: ['expenses-summary', from, to],
    queryFn: () => apiGet<ExpenseSummary>('/expenses/summary', { from, to }),
  });
  // Attribution pickers — fetch once on mount.
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
        <Select
          label="Category"
          value={category}
          onChange={(e) => { setCategory(e.target.value); setPage(1); }}
          options={[
            { value: '', label: 'All categories' },
            ...EXPENSE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? c })),
          ]}
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
          <div key={c.category} className="card p-4">
            <div className="text-xs text-surface-500 dark:text-surface-400">{CATEGORY_LABELS[c.category] ?? c.category}</div>
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
                    <td>{CATEGORY_LABELS[e.category] ?? e.category}</td>
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
          onClose={() => setDownloadOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Download report modal ─────────────────────────────────────────────────

function DownloadReportModal({
  defaultFrom, defaultTo, onClose,
}: {
  defaultFrom: string;
  defaultTo: string;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [scope, setScope] = useState<'consolidated' | 'single'>('consolidated');
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const params: Record<string, string> = { from, to };
      if (scope === 'single') params.category = category;
      const resp = await api.get('/expenses/report/pdf', {
        params,
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url;
      const suffix = scope === 'single' ? category : 'consolidated';
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
                checked={scope === 'consolidated'}
                onChange={() => setScope('consolidated')}
                className="mt-1" />
              <div>
                <div className="font-medium">Consolidated (all categories)</div>
                <div className="text-xs text-surface-500 dark:text-surface-400">
                  Grouped by category with per-category subtotals and a grand total
                </div>
              </div>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="scope" value="single"
                checked={scope === 'single'}
                onChange={() => setScope('single')}
                className="mt-1" />
              <div className="flex-1">
                <div className="font-medium">Single category</div>
                <div className="text-xs text-surface-500 dark:text-surface-400 mb-2">
                  Flat table filtered to one category
                </div>
                {scope === 'single' && (
                  <Select
                    label=""
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? c }))}
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
  mode,
  expense,
  vehicles,
  drivers,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  expense?: Expense;
  vehicles: Vehicle[];
  drivers: Driver[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = mode === 'edit' && !!expense;
  const {
    register, handleSubmit, watch, setValue, formState: { errors },
  } = useForm<CreateExpenseInput>({
    resolver: zodResolver(createExpenseSchema),
    defaultValues: isEdit
      ? {
          expenseDate: expense!.expenseDate,
          category: expense!.category as CreateExpenseInput['category'],
          amount: expense!.amount,
          description: expense!.description,
          paymentMethod: expense!.paymentMethod as CreateExpenseInput['paymentMethod'],
          vendorName: expense!.vendorName ?? undefined,
          vehicleId: expense!.vehicleId ?? undefined,
          driverId: expense!.driverId ?? undefined,
          referenceNumber: expense!.referenceNumber ?? undefined,
          notes: expense!.notes ?? undefined,
        }
      : {
          expenseDate: localTodayISO(),
          category: 'fuel',
          amount: 0,
          description: '',
          paymentMethod: 'cash',
        },
  });

  // Progressive reveal — the current category dictates which fields render.
  const currentCategory = watch('category');
  const fieldCfg = CATEGORY_FIELDS[currentCategory ?? ''] ?? DEFAULT_FIELD_CONFIG;

  // When the user switches category, drop any vehicle/driver value that the
  // new category no longer shows — otherwise stale IDs leak on submit.
  useEffect(() => {
    if (!fieldCfg.showVehicle) setValue('vehicleId', undefined);
    if (!fieldCfg.showDriver) setValue('driverId', undefined);
  }, [currentCategory, fieldCfg.showVehicle, fieldCfg.showDriver, setValue]);

  const mutation = useMutation({
    mutationFn: (data: CreateExpenseInput) => {
      // Blank strings from selects → undefined so zod optional() accepts.
      const clean = {
        ...data,
        vendorName: data.vendorName || undefined,
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
    onError: (err) => toast.error(getErrorMessage(err)),
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
        <Select
          label="Category"
          required
          error={errors.category?.message}
          {...register('category')}
          options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? c }))}
        />
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
            label={fieldCfg.vendorLabel}
            placeholder={fieldCfg.vendorPlaceholder}
            {...register('vendorName')}
          />
        </div>
        {fieldCfg.hint && (
          <p className="text-xs text-slate-500 dark:text-slate-400 -mt-1">{fieldCfg.hint}</p>
        )}
        {(fieldCfg.showVehicle || fieldCfg.showDriver) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {fieldCfg.showVehicle && (
              <Select
                label={`Vehicle${fieldCfg.vehicleRequired ? '' : ' (optional)'}`}
                {...register('vehicleId')}
                options={[
                  { value: '', label: '—' },
                  ...vehicles.map((v) => ({ value: v.id, label: v.vehicleNumber })),
                ]}
              />
            )}
            {fieldCfg.showDriver && (
              <Select
                label={`Driver${fieldCfg.driverRequired ? '' : ' (optional)'}`}
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
          <Input
            label={fieldCfg.referenceLabel}
            placeholder={fieldCfg.referencePlaceholder}
            {...register('referenceNumber')}
          />
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
