import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlineEye,
  HiOutlineTrash,
} from 'react-icons/hi2';
import {
  type Payment,
  type Invoice,
  type PaginationMeta,
  PaymentMethod,
  PaymentAllocationStatus,
  createPaymentSchema,
  type CreatePaymentInput,
  localTodayISO,
  localDateISO,
} from '@gaslink/shared';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';
import { CustomerSearchInput } from '@/components/ui/CustomerSearchInput';

const ALLOCATION_VARIANTS: Record<string, 'success' | 'warning' | 'neutral'> = {
  [PaymentAllocationStatus.FULLY_ALLOCATED]: 'success',
  [PaymentAllocationStatus.PARTIALLY_ALLOCATED]: 'warning',
  [PaymentAllocationStatus.UNALLOCATED]: 'neutral',
};

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
}

export default function PaymentsPage() {
  useQueryClient();
  const [page, setPage] = useState(1);
  const [methodFilter, setMethodFilter] = useState('');
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return localDateISO(d);
  });
  const [dateTo, setDateTo] = useState(() => localTodayISO());
  const [createOpen, setCreateOpen] = useState(false);
  const [viewPayment, setViewPayment] = useState<Payment | null>(null);

  const queryParams: Record<string, unknown> = { page, pageSize: 25 };
  if (methodFilter) queryParams.paymentMethod = methodFilter;
  if (dateFrom) queryParams.dateFrom = dateFrom;
  if (dateTo) queryParams.dateTo = dateTo;

  const { data, isLoading } = useQuery({
    queryKey: ['payments', queryParams],
    queryFn: () => apiGet<{ payments: Payment[]; meta: PaginationMeta }>('/payments', queryParams),
  });

  const payments = data?.payments ?? [];
  const meta = data?.meta;

  const methodOptions = Object.values(PaymentMethod).map((m) => ({ value: m, label: m.replace(/_/g, ' ') }));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Payments</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Track payments and allocations</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <HiOutlinePlus className="h-4 w-4" />
          Record Payment
        </Button>
      </div>

      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Select options={methodOptions} placeholder="All Methods" value={methodFilter} onChange={(e) => { setMethodFilter(e.target.value); setPage(1); }} />
          <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} className="input py-2" />
          <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} className="input py-2" />
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : payments.length === 0 ? (
        <EmptyState
          title="No payments found"
          description="Record your first payment to get started."
          action={<Button onClick={() => setCreateOpen(true)}><HiOutlinePlus className="h-4 w-4" />Record Payment</Button>}
        />
      ) : (
        <>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th>Allocated</th>
                  <th>Unallocated</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.paymentId}>
                    <td>{new Date(payment.transactionDate).toLocaleDateString('en-IN')}</td>
                    <td className="font-medium text-surface-900 dark:text-white">{payment.customerName}</td>
                    <td className="font-medium">{formatCurrency(payment.amount)}</td>
                    <td><Badge variant="neutral">{payment.paymentMethod.replace(/_/g, ' ')}</Badge></td>
                    <td className="text-xs">{payment.referenceNumber || '-'}</td>
                    <td>{formatCurrency(payment.allocatedAmount)}</td>
                    <td className={payment.unallocatedAmount > 0 ? 'text-amber-500 font-medium' : ''}>
                      {formatCurrency(payment.unallocatedAmount)}
                    </td>
                    <td>
                      <Badge variant={ALLOCATION_VARIANTS[payment.allocationStatus] || 'neutral'}>
                        {payment.allocationStatus.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td>
                      <button
                        onClick={() => setViewPayment(payment)}
                        className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500"
                        title="View Allocations"
                      >
                        <HiOutlineEye className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {meta && meta.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-surface-500 dark:text-surface-400">Page {meta.page} of {meta.totalPages}</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button variant="secondary" size="sm" disabled={page >= meta.totalPages} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Create Payment Modal */}
      {createOpen && <CreatePaymentModal open={createOpen} onClose={() => setCreateOpen(false)} />}

      {/* View Allocations Modal */}
      {viewPayment && (
        <Modal open={!!viewPayment} onClose={() => setViewPayment(null)} title="Payment Allocations" size="lg">
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div><p className="text-xs text-surface-400">Customer</p><p className="text-sm font-medium text-surface-900 dark:text-white">{viewPayment.customerName}</p></div>
              <div><p className="text-xs text-surface-400">Total Amount</p><p className="text-sm font-bold">{formatCurrency(viewPayment.amount)}</p></div>
              <div><p className="text-xs text-surface-400">Method</p><p className="text-sm font-medium">{viewPayment.paymentMethod}</p></div>
              <div><p className="text-xs text-surface-400">Date</p><p className="text-sm font-medium">{new Date(viewPayment.transactionDate).toLocaleDateString('en-IN')}</p></div>
            </div>

            {viewPayment.allocations.length === 0 ? (
              <EmptyState title="No allocations" description="This payment has not been allocated to any invoices." />
            ) : (
              <div className="table-container">
                <table className="table">
                  <thead><tr><th>Invoice #</th><th>Allocated Amount</th><th>Date</th></tr></thead>
                  <tbody>
                    {viewPayment.allocations.map((alloc) => (
                      <tr key={alloc.allocationId}>
                        <td className="font-medium">{alloc.invoiceNumber}</td>
                        <td>{formatCurrency(alloc.allocatedAmount)}</td>
                        <td>{new Date(alloc.createdAt).toLocaleDateString('en-IN')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Create Payment Modal ───────────────────────────────────────────────────

function CreatePaymentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [selectedCustomerId, setSelectedCustomerId] = useState('');

  // Customers use the server-side search autocomplete (CustomerSearchInput)
  // — the earlier `pageSize: 100` cap silently hid customers past #100 on
  // distributors with a large book.
  const { data: customerInvoices } = useQuery({
    queryKey: ['customer-unpaid-invoices', selectedCustomerId],
    queryFn: () => apiGet<{ invoices: Invoice[] }>('/invoices', { customerId: selectedCustomerId, status: 'issued', pageSize: 50 }),
    enabled: !!selectedCustomerId,
  });

  const { register, handleSubmit, control, formState: { errors } } = useForm<CreatePaymentInput>({
    resolver: zodResolver(createPaymentSchema),
    defaultValues: {
      customerId: '',
      amount: 0,
      paymentMethod: PaymentMethod.CASH,
      referenceNumber: '',
      // Phase D (2026-06-12): local TZ.
      transactionDate: localTodayISO(),
      allocations: [],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'allocations' });

  const mutation = useMutation({
    mutationFn: (data: CreatePaymentInput) => apiPost('/payments', data),
    onSuccess: () => {
      toast.success('Payment recorded');
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const methodOptions = Object.values(PaymentMethod).map((m) => ({ value: m, label: m.replace(/_/g, ' ') }));
  const unpaidInvoices = customerInvoices?.invoices ?? [];
  const invoiceOptions = unpaidInvoices.map((inv) => ({ value: inv.invoiceId, label: `${inv.invoiceNumber} (${formatCurrency(inv.outstandingAmount)})` }));

  return (
    <Modal open={open} onClose={onClose} title="Record Payment" size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Controller
          control={control}
          name="customerId"
          render={({ field }) => (
            <CustomerSearchInput
              label="Customer"
              required
              value={field.value}
              onChange={(id) => {
                field.onChange(id);
                setSelectedCustomerId(id);
              }}
              error={errors.customerId?.message}
              placeholder="Type 3+ letters to search…"
            />
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <Input label="Amount" type="number" step="0.01" required error={errors.amount?.message} {...register('amount', { valueAsNumber: true })} />
          <Select label="Payment Method" options={methodOptions} required error={errors.paymentMethod?.message} {...register('paymentMethod')} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input label="Reference Number" placeholder="Optional" {...register('referenceNumber')} />
          <Input label="Transaction Date" type="date" required error={errors.transactionDate?.message} {...register('transactionDate')} />
        </div>

        {/* Invoice Allocations */}
        {selectedCustomerId && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label mb-0">Invoice Allocations (Optional)</label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => append({ invoiceId: '', amount: 0 })}
                disabled={invoiceOptions.length === 0}
              >
                <HiOutlinePlus className="h-3 w-3" />Add Allocation
              </Button>
            </div>
            {fields.map((field, index) => (
              <div key={field.id} className="flex items-start gap-2 mb-2">
                <div className="flex-1">
                  <Select options={invoiceOptions} placeholder="Select invoice" {...register(`allocations.${index}.invoiceId`)} />
                </div>
                <div className="w-32">
                  <Input type="number" step="0.01" placeholder="Amount" {...register(`allocations.${index}.amount`, { valueAsNumber: true })} />
                </div>
                <button type="button" onClick={() => remove(index)} className="mt-1 p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg">
                  <HiOutlineTrash className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Record Payment</Button>
        </div>
      </form>
    </Modal>
  );
}
