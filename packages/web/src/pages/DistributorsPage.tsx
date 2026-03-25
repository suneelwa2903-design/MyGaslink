import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlinePencilSquare,
  HiOutlineMagnifyingGlass,
} from 'react-icons/hi2';
import {
  type Distributor,
  DistributorStatus,
  GstMode,
  createDistributorSchema,
  type CreateDistributorInput,
} from '@gaslink/shared';
import { apiGet, apiPost, apiPut, getErrorMessage } from '@/lib/api';
import { Button, Input, Modal, Badge, Loader, EmptyState } from '@/components/ui';

const STATUS_VARIANTS: Record<string, 'success' | 'warning' | 'danger'> = {
  [DistributorStatus.ACTIVE]: 'success',
  [DistributorStatus.SUSPENDED]: 'warning',
  [DistributorStatus.INACTIVE]: 'danger',
};

const GST_MODE_VARIANTS: Record<string, 'success' | 'warning' | 'neutral'> = {
  [GstMode.LIVE]: 'success',
  [GstMode.SANDBOX]: 'warning',
  [GstMode.DISABLED]: 'neutral',
};

export default function DistributorsPage() {
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editDistributor, setEditDistributor] = useState<Distributor | null>(null);

  const { data: distributors, isLoading } = useQuery({
    queryKey: ['distributors'],
    queryFn: () => apiGet<{ distributors: Distributor[] }>('/distributors'),
    select: (data) => data.distributors,
  });

  const filtered = (distributors ?? []).filter((d) =>
    !search || d.businessName.toLowerCase().includes(search.toLowerCase()) || d.legalName.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Distributors</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Manage distributor accounts</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <HiOutlinePlus className="h-4 w-4" />Add Distributor
        </Button>
      </div>

      <div className="card p-4">
        <div className="relative">
          <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-400" />
          <input
            type="text"
            placeholder="Search distributors..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-9 py-2"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No distributors found"
          action={<Button onClick={() => setCreateOpen(true)}><HiOutlinePlus className="h-4 w-4" />Add Distributor</Button>}
        />
      ) : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Business Name</th>
                <th>Legal Name</th>
                <th>GSTIN</th>
                <th>City</th>
                <th>GST Mode</th>
                <th>Billing</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((dist) => (
                <tr key={dist.distributorId}>
                  <td className="font-medium text-surface-900 dark:text-white">{dist.businessName}</td>
                  <td>{dist.legalName}</td>
                  <td className="font-mono text-xs">{dist.gstin || 'N/A'}</td>
                  <td>{dist.city || 'N/A'}</td>
                  <td><Badge variant={GST_MODE_VARIANTS[dist.gstMode] || 'neutral'}>{dist.gstMode}</Badge></td>
                  <td>
                    {dist.billingSuspended ? (
                      <Badge variant="danger">Suspended</Badge>
                    ) : dist.gaslinkBillingEnabled ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="neutral">Disabled</Badge>
                    )}
                  </td>
                  <td><Badge variant={STATUS_VARIANTS[dist.status] || 'neutral'}>{dist.status}</Badge></td>
                  <td>
                    <button
                      onClick={() => setEditDistributor(dist)}
                      className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-500"
                      title="Edit"
                    >
                      <HiOutlinePencilSquare className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Modal */}
      {(createOpen || editDistributor) && (
        <DistributorFormModal
          open={createOpen || !!editDistributor}
          onClose={() => { setCreateOpen(false); setEditDistributor(null); }}
          distributor={editDistributor}
        />
      )}
    </div>
  );
}

function DistributorFormModal({
  open,
  onClose,
  distributor,
}: {
  open: boolean;
  onClose: () => void;
  distributor: Distributor | null;
}) {
  const queryClient = useQueryClient();
  const isEdit = !!distributor;

  const { register, handleSubmit, formState: { errors } } = useForm<CreateDistributorInput>({
    resolver: zodResolver(createDistributorSchema),
    defaultValues: distributor
      ? {
          businessName: distributor.businessName,
          legalName: distributor.legalName,
          gstin: distributor.gstin || '',
          address: distributor.address || '',
          city: distributor.city || '',
          state: distributor.state || '',
          pincode: distributor.pincode || '',
          phone: distributor.phone || '',
          email: distributor.email || '',
        }
      : { businessName: '', legalName: '' },
  });

  const mutation = useMutation({
    mutationFn: (data: CreateDistributorInput) =>
      isEdit ? apiPut(`/distributors/${distributor.distributorId}`, data) : apiPost('/distributors', data),
    onSuccess: () => {
      toast.success(isEdit ? 'Distributor updated' : 'Distributor created');
      queryClient.invalidateQueries({ queryKey: ['distributors'] });
      queryClient.invalidateQueries({ queryKey: ['distributors-list'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Distributor' : 'Add Distributor'} size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Business Name" required error={errors.businessName?.message} {...register('businessName')} />
          <Input label="Legal Name" required error={errors.legalName?.message} {...register('legalName')} />
          <Input label="GSTIN" placeholder="e.g. 29ABCDE1234F1Z5" {...register('gstin')} />
          <Input label="Phone" {...register('phone')} />
          <Input label="Email" type="email" {...register('email')} />
          <Input label="Address" {...register('address')} />
          <Input label="City" {...register('city')} />
          <Input label="State" {...register('state')} />
          <Input label="Pincode" {...register('pincode')} />
        </div>
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>{isEdit ? 'Update' : 'Create'}</Button>
        </div>
      </form>
    </Modal>
  );
}
