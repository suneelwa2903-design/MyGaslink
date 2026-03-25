import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlineCheckCircle,
  HiOutlineEye,
} from 'react-icons/hi2';
import {
  type BillingCycle,
  BillingStatus,
  UserRole,
} from '@gaslink/shared';
import { apiGet, apiPost, apiPut, getErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { Button, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';

const STATUS_VARIANTS: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  [BillingStatus.PENDING_GENERATION]: 'neutral',
  [BillingStatus.INVOICE_GENERATED]: 'info',
  [BillingStatus.PENDING_PAYMENT]: 'warning',
  [BillingStatus.PAID]: 'success',
  [BillingStatus.OVERDUE]: 'danger',
  [BillingStatus.SUSPENDED]: 'danger',
};

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
}

export default function BillingPage() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const isSuperAdmin = user?.role === UserRole.SUPER_ADMIN;
  const [statusFilter, setStatusFilter] = useState('');
  const [viewCycle, setViewCycle] = useState<BillingCycle | null>(null);

  const queryParams: Record<string, unknown> = {};
  if (statusFilter) queryParams.billingStatus = statusFilter;

  const { data: cycles, isLoading } = useQuery({
    queryKey: ['billing-cycles', queryParams],
    queryFn: () => apiGet<{ cycles: BillingCycle[] }>('/billing/cycles', queryParams),
    select: (data) => data.cycles,
  });

  const generateMutation = useMutation({
    mutationFn: () => apiPost('/billing/generate'),
    onSuccess: () => {
      toast.success('Billing generated');
      queryClient.invalidateQueries({ queryKey: ['billing-cycles'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const markPaidMutation = useMutation({
    mutationFn: (cycleId: string) => apiPut(`/billing/cycles/${cycleId}/mark-paid`),
    onSuccess: () => {
      toast.success('Marked as paid');
      queryClient.invalidateQueries({ queryKey: ['billing-cycles'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const statusOptions = Object.values(BillingStatus).map((s) => ({ value: s, label: s.replace(/_/g, ' ') }));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Billing</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
            {isSuperAdmin ? 'Manage GasLink billing for all distributors' : 'View your billing status'}
          </p>
        </div>
        {isSuperAdmin && (
          <Button onClick={() => generateMutation.mutate()} loading={generateMutation.isPending}>
            <HiOutlinePlus className="h-4 w-4" />Generate Billing
          </Button>
        )}
      </div>

      <div className="card p-4">
        <Select
          options={statusOptions}
          placeholder="All Statuses"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : !cycles?.length ? (
        <EmptyState title="No billing cycles" description="Billing cycles will appear here once generated." />
      ) : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                {isSuperAdmin && <th>Distributor</th>}
                <th>Period</th>
                <th>Start</th>
                <th>End</th>
                <th>Tier</th>
                <th>Excl GST</th>
                <th>GST</th>
                <th>Total</th>
                <th>Due Date</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((cycle) => (
                <tr key={cycle.cycleId}>
                  {isSuperAdmin && <td className="font-medium text-surface-900 dark:text-white">{cycle.distributorName}</td>}
                  <td><Badge variant="neutral">{cycle.periodType}</Badge></td>
                  <td>{new Date(cycle.periodStartDate).toLocaleDateString('en-IN')}</td>
                  <td>{new Date(cycle.periodEndDate).toLocaleDateString('en-IN')}</td>
                  <td><Badge variant="info">{cycle.billingTier}</Badge></td>
                  <td>{formatCurrency(cycle.totalAmountExclGst)}</td>
                  <td>{formatCurrency(cycle.totalGstAmount)}</td>
                  <td className="font-medium">{formatCurrency(cycle.totalAmountInclGst)}</td>
                  <td>{cycle.dueDate ? new Date(cycle.dueDate).toLocaleDateString('en-IN') : '-'}</td>
                  <td><Badge variant={STATUS_VARIANTS[cycle.billingStatus] || 'neutral'}>{cycle.billingStatus.replace(/_/g, ' ')}</Badge></td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setViewCycle(cycle)}
                        className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500"
                        title="View Details"
                      >
                        <HiOutlineEye className="h-4 w-4" />
                      </button>
                      {isSuperAdmin && cycle.billingStatus !== BillingStatus.PAID && (
                        <button
                          onClick={() => markPaidMutation.mutate(cycle.cycleId)}
                          className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-accent-500"
                          title="Mark Paid"
                        >
                          <HiOutlineCheckCircle className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Cycle Detail Modal */}
      {viewCycle && (
        <Modal open={!!viewCycle} onClose={() => setViewCycle(null)} title="Billing Cycle Details" size="lg">
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div><p className="text-xs text-surface-400">Distributor</p><p className="text-sm font-medium text-surface-900 dark:text-white">{viewCycle.distributorName}</p></div>
              <div><p className="text-xs text-surface-400">Period</p><p className="text-sm font-medium">{viewCycle.periodType}</p></div>
              <div><p className="text-xs text-surface-400">Tier</p><p className="text-sm font-medium">{viewCycle.billingTier}</p></div>
              <div><p className="text-xs text-surface-400">Status</p><Badge variant={STATUS_VARIANTS[viewCycle.billingStatus] || 'neutral'}>{viewCycle.billingStatus}</Badge></div>
            </div>

            {viewCycle.items.length > 0 && (
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr><th>Description</th><th>HSN</th><th>Qty</th><th>Unit Price</th><th>GST%</th><th>Discount</th><th>Total</th></tr>
                  </thead>
                  <tbody>
                    {viewCycle.items.map((item) => (
                      <tr key={item.itemId}>
                        <td>{item.description}</td>
                        <td>{item.hsnCode}</td>
                        <td>{item.quantity}</td>
                        <td>{formatCurrency(item.unitPriceExclGst)}</td>
                        <td>{item.gstRate}%</td>
                        <td>{formatCurrency(item.discountAmount)}</td>
                        <td className="font-medium">{formatCurrency(item.lineTotalInclGst)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="grid grid-cols-3 gap-4 pt-4 border-t border-surface-200 dark:border-surface-700">
              <div><p className="text-xs text-surface-400">Subtotal</p><p className="font-medium">{formatCurrency(viewCycle.totalAmountExclGst)}</p></div>
              <div><p className="text-xs text-surface-400">GST</p><p className="font-medium">{formatCurrency(viewCycle.totalGstAmount)}</p></div>
              <div><p className="text-xs text-surface-400">Total</p><p className="font-bold text-lg">{formatCurrency(viewCycle.totalAmountInclGst)}</p></div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
