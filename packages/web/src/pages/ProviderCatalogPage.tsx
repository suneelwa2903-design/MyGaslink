import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlinePencilSquare,
  HiOutlineMagnifyingGlass,
  HiOutlineTrash,
} from 'react-icons/hi2';
import type { ProviderCatalogCylinderType } from '@gaslink/shared';
import { apiGet, apiPost, apiPut, apiDelete, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';
import { z } from 'zod';

const PROVIDER_CODES = ['IOCL', 'HPCL', 'BPCL', 'GOGAS', 'SUPERGAS', 'TOTALGAS', 'OTHERS'] as const;

const PROVIDER_BADGE_VARIANT: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  IOCL: 'info',
  HPCL: 'success',
  BPCL: 'warning',
  GOGAS: 'danger',
  SUPERGAS: 'neutral',
  TOTALGAS: 'info',
  OTHERS: 'neutral',
};

const catalogSchema = z.object({
  providerCode: z.enum(PROVIDER_CODES),
  shortName: z.string().min(1, 'Required').max(50),
  longName: z.string().min(1, 'Required').max(200),
  weight: z.coerce.number().positive('Must be positive'),
  hsnCode: z.string().max(20).default('27111900'),
  isActive: z.boolean().default(true),
});

type CatalogFormData = z.infer<typeof catalogSchema>;

export default function ProviderCatalogPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState<ProviderCatalogCylinderType | null>(null);

  const queryParams: Record<string, unknown> = {};
  if (providerFilter) queryParams.provider = providerFilter;

  const { data, isLoading } = useQuery({
    queryKey: ['provider-catalog', queryParams],
    queryFn: () => apiGet<{ items: ProviderCatalogCylinderType[] }>('/provider-catalog', queryParams),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/provider-catalog/${id}`),
    onSuccess: () => {
      toast.success('Entry deactivated');
      queryClient.invalidateQueries({ queryKey: ['provider-catalog'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const allItems = data?.items ?? [];

  // Client-side search filter
  const items = search
    ? allItems.filter(
        (item) =>
          item.shortName.toLowerCase().includes(search.toLowerCase()) ||
          item.longName.toLowerCase().includes(search.toLowerCase()) ||
          item.providerCode.toLowerCase().includes(search.toLowerCase())
      )
    : allItems;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Provider Catalog</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
            Master list of cylinder types by provider
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <HiOutlinePlus className="h-4 w-4" />
          Add Cylinder Type
        </Button>
      </div>

      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="relative sm:col-span-2">
            <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-400" />
            <input
              type="text"
              placeholder="Search by name or provider..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-9 py-2"
            />
          </div>
          <Select
            options={PROVIDER_CODES.map((code) => ({ value: code, label: code }))}
            placeholder="All Providers"
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader size="lg" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No catalog entries found"
          description="Add your first provider cylinder type to get started."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <HiOutlinePlus className="h-4 w-4" />
              Add Cylinder Type
            </Button>
          }
        />
      ) : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Short Name</th>
                <th>Long Name</th>
                <th>Weight (KG)</th>
                <th>HSN Code</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Badge variant={PROVIDER_BADGE_VARIANT[item.providerCode] || 'neutral'}>
                      {item.providerCode}
                    </Badge>
                  </td>
                  <td className="font-medium text-surface-900 dark:text-white">
                    {item.shortName}
                  </td>
                  <td className="text-surface-600 dark:text-surface-300">{item.longName}</td>
                  <td>{item.weight}</td>
                  <td className="text-surface-500">{item.hsnCode}</td>
                  <td>
                    {item.isActive ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="danger">Inactive</Badge>
                    )}
                  </td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditItem(item)}
                        className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-500"
                        title="Edit"
                      >
                        <HiOutlinePencilSquare className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm('Deactivate this cylinder type?')) {
                            deleteMutation.mutate(item.id);
                          }
                        }}
                        className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-red-500"
                        title="Deactivate"
                      >
                        <HiOutlineTrash className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Modal */}
      {createOpen && (
        <CatalogFormModal open={createOpen} onClose={() => setCreateOpen(false)} />
      )}

      {/* Edit Modal */}
      {editItem && (
        <CatalogFormModal open={!!editItem} onClose={() => setEditItem(null)} item={editItem} />
      )}
    </div>
  );
}

// ─── Create / Edit Modal ────────────────────────────────────────────────────

function CatalogFormModal({
  open,
  onClose,
  item,
}: {
  open: boolean;
  onClose: () => void;
  item?: ProviderCatalogCylinderType;
}) {
  const queryClient = useQueryClient();
  const isEdit = !!item;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CatalogFormData>({
    resolver: zodResolver(catalogSchema) as Resolver<CatalogFormData>,
    defaultValues: item
      ? {
          providerCode: item.providerCode as CatalogFormData['providerCode'],
          shortName: item.shortName,
          longName: item.longName,
          weight: item.weight,
          hsnCode: item.hsnCode,
          isActive: item.isActive,
        }
      : {
          providerCode: 'IOCL',
          shortName: '',
          longName: '',
          weight: 0,
          hsnCode: '27111900',
          isActive: true,
        },
  });

  const mutation = useMutation({
    mutationFn: (data: CatalogFormData) =>
      isEdit
        ? apiPut(`/provider-catalog/${item.id}`, data)
        : apiPost('/provider-catalog', data),
    onSuccess: () => {
      toast.success(isEdit ? 'Entry updated' : 'Entry created');
      queryClient.invalidateQueries({ queryKey: ['provider-catalog'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Cylinder Type' : 'Add Cylinder Type'} size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select
            label="Provider"
            required
            options={PROVIDER_CODES.map((code) => ({ value: code, label: code }))}
            error={errors.providerCode?.message}
            {...register('providerCode')}
          />
          <Input
            label="Short Name"
            required
            placeholder="e.g. 19 KG"
            error={errors.shortName?.message}
            {...register('shortName')}
          />
          <Input
            label="Long Name"
            required
            placeholder="e.g. HPCL 19 KG Domestic Cylinder"
            error={errors.longName?.message}
            {...register('longName')}
          />
          <Input
            label="Weight (KG)"
            required
            type="number"
            step="0.01"
            error={errors.weight?.message}
            {...register('weight', { valueAsNumber: true })}
          />
          <Input
            label="HSN Code"
            placeholder="27111900"
            error={errors.hsnCode?.message}
            {...register('hsnCode')}
          />
          <div className="flex items-center gap-2 pt-6">
            <input
              type="checkbox"
              id="isActive"
              className="rounded border-surface-300 text-brand-500 focus:ring-brand-500"
              {...register('isActive')}
            />
            <label htmlFor="isActive" className="text-sm font-medium text-surface-700 dark:text-surface-300">
              Active
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            {isEdit ? 'Update' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
