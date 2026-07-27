/**
 * Mini-op #5 v2 (2026-07-27 evening) — Settings > Categories tab.
 *
 * Tenant-owned expense taxonomy manager. Distributor admins can add
 * headers + leaves, rename, hide, promote/demote system defaults, and
 * restore system defaults. System-seeded rows are renameable + hideable
 * but not deletable — the delete button hides on those rows.
 *
 * Progressive-reveal knobs (showVehicle / vendorLabel / hint / etc.)
 * live in the edit modal.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineArrowPath,
  HiOutlineEye, HiOutlineEyeSlash,
} from 'react-icons/hi2';
import {
  createExpenseCategorySchema,
  updateExpenseCategorySchema,
  type CreateExpenseCategoryInput,
  type UpdateExpenseCategoryInput,
  type ExpenseCategory,
} from '@gaslink/shared';
import { apiGet, apiPost, apiPut, apiDelete, getErrorMessage } from '@/lib/api';
import { Button, Input, Modal, Loader, EmptyState, Select, Badge } from '@/components/ui';

interface CategoriesResponse { categories: ExpenseCategory[] }

interface TreeNode { row: ExpenseCategory; children: TreeNode[] }

function buildTree(rows: ExpenseCategory[]): TreeNode[] {
  const headers = rows.filter((c) => c.isHeader).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const byParent = new Map<string, ExpenseCategory[]>();
  const orphans: ExpenseCategory[] = [];
  for (const c of rows) {
    if (c.isHeader) continue;
    if (c.parentId) {
      const arr = byParent.get(c.parentId) ?? [];
      arr.push(c);
      byParent.set(c.parentId, arr);
    } else {
      orphans.push(c);
    }
  }
  const sortLeaves = (arr: ExpenseCategory[]) =>
    arr.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const tree = headers.map((h) => ({
    row: h,
    children: sortLeaves(byParent.get(h.categoryId) ?? []).map((c) => ({ row: c, children: [] })),
  }));
  if (orphans.length) {
    tree.push({
      row: {
        // Synthetic header row for orphan leaves. Not persisted anywhere.
        categoryId: '__orphans__', distributorId: '', parentId: null, code: '__orphans__',
        name: 'Uncategorised', isHeader: true, isSystem: false, isActive: true,
        sortOrder: 9999, showVehicle: false, vehicleRequired: false, showDriver: false,
        driverRequired: false,
        showPaidTo: false, paidToRequired: false, paidToLabel: null, paidToPlaceholder: null,
        vendorLabel: null, vendorPlaceholder: null,
        referenceLabel: null, referencePlaceholder: null, hint: null,
        taxDeductibleHint: null, reservedForImport: false, path: 'Uncategorised', expenseCount: 0,
      },
      children: sortLeaves(orphans).map((c) => ({ row: c, children: [] })),
    });
  }
  return tree;
}

export function ExpenseCategoriesTab() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => apiGet<CategoriesResponse>('/expense-categories'),
  });
  const categories = query.data?.categories ?? [];
  const tree = useMemo(() => buildTree(categories), [categories]);
  const activeHeaders = useMemo(
    () => categories.filter((c) => c.isHeader && c.isActive && c.categoryId !== '__orphans__'),
    [categories],
  );

  const [creating, setCreating] = useState<null | { kind: 'header' } | { kind: 'leaf'; parentId: string | null }>(null);
  const [editing, setEditing] = useState<ExpenseCategory | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['expense-categories'] });
    queryClient.invalidateQueries({ queryKey: ['expenses'] });
    queryClient.invalidateQueries({ queryKey: ['expenses-summary'] });
  };

  const toggleActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiPut(`/expense-categories/${id}`, { isActive }),
    onSuccess: () => { toast.success('Updated'); invalidate(); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/expense-categories/${id}`),
    onSuccess: () => { toast.success('Deleted'); invalidate(); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const restoreMutation = useMutation({
    mutationFn: () => apiPost('/expense-categories/restore-system-defaults', {}),
    onSuccess: () => { toast.success('System defaults restored'); invalidate(); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  if (query.isLoading) return <div className="flex justify-center py-16"><Loader /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-surface-900 dark:text-white">Expense categories</h2>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
            Every expense you record is filed under one of these. System defaults are
            renameable and hideable; you can add your own alongside them. Categories
            with historical expenses cannot be deleted — hide them instead.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => restoreMutation.mutate()} loading={restoreMutation.isPending}>
            <HiOutlineArrowPath className="h-4 w-4" />
            Restore defaults
          </Button>
          <Button variant="secondary" onClick={() => setCreating({ kind: 'header' })}>
            <HiOutlinePlus className="h-4 w-4" />
            Add header
          </Button>
          <Button onClick={() => setCreating({ kind: 'leaf', parentId: activeHeaders[0]?.categoryId ?? null })}>
            <HiOutlinePlus className="h-4 w-4" />
            Add category
          </Button>
        </div>
      </div>

      {tree.length === 0 ? (
        <EmptyState title="No categories yet" description="Add your first header + leaves to start recording expenses." />
      ) : (
        <div className="space-y-4">
          {tree.map((node) => (
            <div key={node.row.categoryId} className="card">
              <div className="flex items-center justify-between p-3 border-b border-surface-200 dark:border-surface-700">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-surface-900 dark:text-white uppercase text-xs tracking-wide">
                    {node.row.name}
                  </span>
                  {node.row.isSystem && <Badge>system</Badge>}
                  {!node.row.isActive && <Badge>hidden</Badge>}
                  <span className="text-xs text-surface-400">{node.children.length} categories</span>
                </div>
                {node.row.categoryId !== '__orphans__' && (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setCreating({ kind: 'leaf', parentId: node.row.categoryId })}>
                      <HiOutlinePlus className="h-4 w-4" /> Add under this
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(node.row)}>
                      <HiOutlinePencilSquare className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => toggleActive.mutate({ id: node.row.categoryId, isActive: !node.row.isActive })}
                      title={node.row.isActive ? 'Hide' : 'Show'}
                    >
                      {node.row.isActive ? <HiOutlineEyeSlash className="h-4 w-4" /> : <HiOutlineEye className="h-4 w-4" />}
                    </Button>
                    {!node.row.isSystem && (
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => {
                          if (window.confirm(`Delete header "${node.row.name}"? Only allowed if it has no children.`)) {
                            deleteMutation.mutate(node.row.categoryId);
                          }
                        }}
                      >
                        <HiOutlineTrash className="h-4 w-4 text-red-500" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <div className="divide-y divide-surface-100 dark:divide-surface-800">
                {node.children.length === 0 ? (
                  <div className="p-3 text-sm italic text-surface-400">No categories in this header yet.</div>
                ) : node.children.map((leaf) => (
                  <div key={leaf.row.categoryId} className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm ${leaf.row.isActive ? 'text-surface-900 dark:text-white' : 'text-surface-400 line-through'}`}>
                        {leaf.row.name}
                      </span>
                      {leaf.row.isSystem && <Badge>system</Badge>}
                      {!leaf.row.isActive && <Badge>hidden</Badge>}
                      {leaf.row.expenseCount > 0 && (
                        <span className="text-xs text-surface-400">{leaf.row.expenseCount} expenses</span>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(leaf.row)}>
                        <HiOutlinePencilSquare className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => toggleActive.mutate({ id: leaf.row.categoryId, isActive: !leaf.row.isActive })}
                        title={leaf.row.isActive ? 'Hide' : 'Show'}
                      >
                        {leaf.row.isActive ? <HiOutlineEyeSlash className="h-4 w-4" /> : <HiOutlineEye className="h-4 w-4" />}
                      </Button>
                      {!leaf.row.isSystem && leaf.row.expenseCount === 0 && (
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => {
                            if (window.confirm(`Delete category "${leaf.row.name}"?`)) {
                              deleteMutation.mutate(leaf.row.categoryId);
                            }
                          }}
                        >
                          <HiOutlineTrash className="h-4 w-4 text-red-500" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <CreateCategoryModal
          initial={creating}
          headers={activeHeaders}
          onClose={() => setCreating(null)}
          onSaved={() => { invalidate(); setCreating(null); }}
        />
      )}

      {editing && editing.categoryId !== '__orphans__' && (
        <EditCategoryModal
          category={editing}
          headers={activeHeaders}
          onClose={() => setEditing(null)}
          onSaved={() => { invalidate(); setEditing(null); }}
        />
      )}
    </div>
  );
}

// ─── Create modal ────────────────────────────────────────────────────────

function CreateCategoryModal({
  initial, headers, onClose, onSaved,
}: {
  initial: { kind: 'header' } | { kind: 'leaf'; parentId: string | null };
  headers: ExpenseCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isHeader = initial.kind === 'header';
  const {
    register, handleSubmit, formState: { errors }, watch,
  } = useForm<CreateExpenseCategoryInput>({
    resolver: zodResolver(createExpenseCategorySchema),
    defaultValues: {
      name: '',
      isHeader,
      parentId: isHeader ? null : (initial.kind === 'leaf' ? initial.parentId : null),
      sortOrder: 100,
      showVehicle: false,
      showDriver: false,
    },
  });
  const showAdvanced = !isHeader;
  const showVehicle = watch('showVehicle');
  const showDriver = watch('showDriver');

  const mutation = useMutation({
    mutationFn: (data: CreateExpenseCategoryInput) => apiPost('/expense-categories', data),
    onSuccess: () => { toast.success(isHeader ? 'Header added' : 'Category added'); onSaved(); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <Modal open onClose={onClose} title={isHeader ? 'Add header' : 'Add category'} size="md">
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-3">
        <Input label="Name" required placeholder={isHeader ? 'e.g. Vehicle Costs' : 'e.g. Toll charges'} error={errors.name?.message} {...register('name')} />
        {!isHeader && (
          <Select
            label="Under header"
            required
            {...register('parentId')}
            options={headers.map((h) => ({ value: h.categoryId, label: h.name }))}
          />
        )}
        {showAdvanced && (
          <details className="text-sm">
            <summary className="cursor-pointer text-surface-600 dark:text-surface-300 font-medium">Advanced (form knobs)</summary>
            <div className="mt-3 space-y-3 pl-2 border-l-2 border-surface-200 dark:border-surface-700">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center gap-2">
                  <input type="checkbox" {...register('showVehicle')} />
                  <span>Show vehicle picker</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" {...register('vehicleRequired')} disabled={!showVehicle} />
                  <span>Vehicle required</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" {...register('showDriver')} />
                  <span>Show driver picker</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" {...register('driverRequired')} disabled={!showDriver} />
                  <span>Driver required</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" {...register('showPaidTo')} />
                  <span>Show "Paid to" text field</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" {...register('paidToRequired')} disabled={!watch('showPaidTo')} />
                  <span>Paid-to required</span>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Paid-to label" placeholder="Paid to" {...register('paidToLabel')} />
                <Input label="Paid-to placeholder" placeholder="Recipient name" {...register('paidToPlaceholder')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Vendor label" placeholder="Vendor" {...register('vendorLabel')} />
                <Input label="Vendor placeholder" placeholder="Vendor name" {...register('vendorPlaceholder')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Reference label" placeholder="Reference #" {...register('referenceLabel')} />
                <Input label="Reference placeholder" placeholder="Any reference" {...register('referencePlaceholder')} />
              </div>
              <Input label="Hint" placeholder="Optional guidance shown under the form" {...register('hint')} />
            </div>
          </details>
        )}
        <div className="flex justify-end gap-3 pt-3">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Add</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Edit modal ──────────────────────────────────────────────────────────

function EditCategoryModal({
  category, headers, onClose, onSaved,
}: {
  category: ExpenseCategory;
  headers: ExpenseCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const {
    register, handleSubmit, formState: { errors }, watch,
  } = useForm<UpdateExpenseCategoryInput>({
    resolver: zodResolver(updateExpenseCategorySchema),
    defaultValues: {
      name: category.name,
      isActive: category.isActive,
      parentId: category.parentId,
      sortOrder: category.sortOrder,
      showVehicle: category.showVehicle,
      vehicleRequired: category.vehicleRequired,
      showDriver: category.showDriver,
      driverRequired: category.driverRequired,
      showPaidTo: category.showPaidTo,
      paidToRequired: category.paidToRequired,
      paidToLabel: category.paidToLabel ?? undefined,
      paidToPlaceholder: category.paidToPlaceholder ?? undefined,
      vendorLabel: category.vendorLabel ?? undefined,
      vendorPlaceholder: category.vendorPlaceholder ?? undefined,
      referenceLabel: category.referenceLabel ?? undefined,
      referencePlaceholder: category.referencePlaceholder ?? undefined,
      hint: category.hint ?? undefined,
    },
  });
  const showVehicle = watch('showVehicle');
  const showDriver = watch('showDriver');
  const showPaidTo = watch('showPaidTo');

  const mutation = useMutation({
    mutationFn: (data: UpdateExpenseCategoryInput) => apiPut(`/expense-categories/${category.categoryId}`, data),
    onSuccess: () => { toast.success('Saved'); onSaved(); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <Modal open onClose={onClose} title={`Edit ${category.isHeader ? 'header' : 'category'}`} size="md">
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-3">
        <div className="text-xs text-surface-400">
          Code: <code>{category.code}</code> (immutable) {category.isSystem && ' · system-seeded'}
        </div>
        <Input label="Name" required error={errors.name?.message} {...register('name')} />
        {!category.isHeader && (
          <Select
            label="Under header"
            {...register('parentId')}
            options={[{ value: '', label: '— none (uncategorised) —' }, ...headers.map((h) => ({ value: h.categoryId, label: h.name }))]}
          />
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" {...register('isActive')} />
          <span>Active (uncheck to hide from the picker without losing history)</span>
        </label>
        {!category.isHeader && (
          <details className="text-sm" open>
            <summary className="cursor-pointer text-surface-600 dark:text-surface-300 font-medium">Form knobs (progressive reveal)</summary>
            <div className="mt-3 space-y-3 pl-2 border-l-2 border-surface-200 dark:border-surface-700">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center gap-2">
                  <input type="checkbox" {...register('showVehicle')} />
                  <span>Show vehicle picker</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" {...register('vehicleRequired')} disabled={!showVehicle} />
                  <span>Vehicle required</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" {...register('showDriver')} />
                  <span>Show driver picker</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" {...register('driverRequired')} disabled={!showDriver} />
                  <span>Driver required</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" {...register('showPaidTo')} />
                  <span>Show "Paid to" text field</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" {...register('paidToRequired')} disabled={!showPaidTo} />
                  <span>Paid-to required</span>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Paid-to label" {...register('paidToLabel')} />
                <Input label="Paid-to placeholder" {...register('paidToPlaceholder')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Vendor label" {...register('vendorLabel')} />
                <Input label="Vendor placeholder" {...register('vendorPlaceholder')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Reference label" {...register('referenceLabel')} />
                <Input label="Reference placeholder" {...register('referencePlaceholder')} />
              </div>
              <Input label="Hint" {...register('hint')} />
            </div>
          </details>
        )}
        <div className="flex justify-end gap-3 pt-3">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}
