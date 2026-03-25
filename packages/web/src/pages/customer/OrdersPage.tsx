import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlineEye,
  HiOutlineTrash,
} from 'react-icons/hi2';
import {
  type Order,
  type CylinderType,
  type PaginationMeta,
  OrderStatus,
  createOrderSchema,
  type CreateOrderInput,
} from '@gaslink/shared';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';

const STATUS_VARIANTS: Record<string, 'info' | 'warning' | 'success' | 'danger' | 'neutral'> = {
  [OrderStatus.PENDING_DRIVER_ASSIGNMENT]: 'warning',
  [OrderStatus.PENDING_DISPATCH]: 'info',
  [OrderStatus.PENDING_DELIVERY]: 'info',
  [OrderStatus.DELIVERED]: 'success',
  [OrderStatus.MODIFIED_DELIVERED]: 'success',
  [OrderStatus.CANCELLED]: 'danger',
};

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
}

export default function CustomerOrdersPage() {
  const { user } = useAuthStore();
  useQueryClient();
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [viewOrder, setViewOrder] = useState<Order | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['customer-orders', page],
    queryFn: () => apiGet<{ orders: Order[]; meta: PaginationMeta }>('/customer-portal/orders', { page, pageSize: 25 }),
  });

  const { data: cylinderTypes } = useQuery({
    queryKey: ['cylinder-types'],
    queryFn: () => apiGet<{ cylinderTypes: CylinderType[] }>('/cylinder-types'),
    select: (data) => data.cylinderTypes,
    staleTime: 10 * 60 * 1000,
  });

  const orders = data?.orders ?? [];
  const meta = data?.meta;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">My Orders</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">View and create orders</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <HiOutlinePlus className="h-4 w-4" />New Order
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          description="Place your first order to get started."
          action={<Button onClick={() => setCreateOpen(true)}><HiOutlinePlus className="h-4 w-4" />New Order</Button>}
        />
      ) : (
        <>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr><th>Order #</th><th>Order Date</th><th>Delivery Date</th><th>Items</th><th>Amount</th><th>Status</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.orderId}>
                    <td className="font-medium text-surface-900 dark:text-white">{order.orderNumber}</td>
                    <td>{new Date(order.orderDate).toLocaleDateString('en-IN')}</td>
                    <td>{new Date(order.deliveryDate).toLocaleDateString('en-IN')}</td>
                    <td>{order.items.length} items</td>
                    <td className="font-medium">{formatCurrency(order.totalAmount)}</td>
                    <td><Badge variant={STATUS_VARIANTS[order.status] || 'neutral'}>{order.status.replace(/_/g, ' ')}</Badge></td>
                    <td>
                      <button onClick={() => setViewOrder(order)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500">
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

      {/* View Order Detail */}
      {viewOrder && (
        <Modal open={!!viewOrder} onClose={() => setViewOrder(null)} title={`Order ${viewOrder.orderNumber}`} size="lg">
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div><p className="text-xs text-surface-400">Order Date</p><p className="text-sm font-medium">{new Date(viewOrder.orderDate).toLocaleDateString('en-IN')}</p></div>
              <div><p className="text-xs text-surface-400">Delivery Date</p><p className="text-sm font-medium">{new Date(viewOrder.deliveryDate).toLocaleDateString('en-IN')}</p></div>
              <div><p className="text-xs text-surface-400">Driver</p><p className="text-sm font-medium">{viewOrder.driverName || 'Not assigned'}</p></div>
              <div><p className="text-xs text-surface-400">Status</p><Badge variant={STATUS_VARIANTS[viewOrder.status] || 'neutral'}>{viewOrder.status.replace(/_/g, ' ')}</Badge></div>
            </div>
            <div className="table-container">
              <table className="table">
                <thead><tr><th>Cylinder</th><th>Qty</th><th>Delivered</th><th>Empties</th><th>Unit Price</th><th>Total</th></tr></thead>
                <tbody>
                  {viewOrder.items.map((item) => (
                    <tr key={item.orderItemId}>
                      <td className="font-medium">{item.cylinderTypeName}</td>
                      <td>{item.quantity}</td>
                      <td>{item.deliveredQuantity ?? '-'}</td>
                      <td>{item.emptiesCollected ?? '-'}</td>
                      <td>{formatCurrency(item.unitPrice)}</td>
                      <td className="font-medium">{formatCurrency(item.totalPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-right"><p className="text-lg font-bold text-surface-900 dark:text-white">Total: {formatCurrency(viewOrder.totalAmount)}</p></div>
            {viewOrder.specialInstructions && (
              <div className="p-3 bg-surface-50 dark:bg-surface-800/50 rounded-xl">
                <p className="text-xs text-surface-400">Special Instructions</p>
                <p className="text-sm text-surface-700 dark:text-surface-300">{viewOrder.specialInstructions}</p>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Create Order Modal */}
      {createOpen && (
        <CustomerCreateOrderModal open={createOpen} onClose={() => setCreateOpen(false)} cylinderTypes={cylinderTypes ?? []} customerId={user?.customerId || ''} />
      )}
    </div>
  );
}

function CustomerCreateOrderModal({ open, onClose, cylinderTypes, customerId }: { open: boolean; onClose: () => void; cylinderTypes: CylinderType[]; customerId: string }) {
  const queryClient = useQueryClient();

  const { register, handleSubmit, control, formState: { errors } } = useForm<CreateOrderInput>({
    resolver: zodResolver(createOrderSchema),
    defaultValues: {
      customerId,
      deliveryDate: new Date().toISOString().split('T')[0],
      specialInstructions: '',
      items: [{ cylinderTypeId: '', quantity: 1 }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  const mutation = useMutation({
    mutationFn: (data: CreateOrderInput) => apiPost('/customer-portal/orders', data),
    onSuccess: () => {
      toast.success('Order placed successfully');
      queryClient.invalidateQueries({ queryKey: ['customer-orders'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: `${ct.typeName} (${ct.capacity}${ct.unit})` }));

  return (
    <Modal open={open} onClose={onClose} title="Place New Order" size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <input type="hidden" {...register('customerId')} />
        <Input label="Preferred Delivery Date" type="date" error={errors.deliveryDate?.message} {...register('deliveryDate')} />

        <div>
          <label className="label">Order Items</label>
          {fields.map((field, index) => (
            <div key={field.id} className="flex items-start gap-2 mb-2">
              <div className="flex-1">
                <Select options={cylinderOptions} placeholder="Select cylinder" error={errors.items?.[index]?.cylinderTypeId?.message} {...register(`items.${index}.cylinderTypeId`)} />
              </div>
              <div className="w-24">
                <Input type="number" placeholder="Qty" min={1} error={errors.items?.[index]?.quantity?.message} {...register(`items.${index}.quantity`, { valueAsNumber: true })} />
              </div>
              {fields.length > 1 && (
                <button type="button" onClick={() => remove(index)} className="mt-1 p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg">
                  <HiOutlineTrash className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {errors.items?.message && <p className="error-text">{errors.items.message}</p>}
          <Button type="button" variant="ghost" size="sm" className="mt-1" onClick={() => append({ cylinderTypeId: '', quantity: 1 })}>
            <HiOutlinePlus className="h-3 w-3" />Add Item
          </Button>
        </div>

        <Input label="Special Instructions" placeholder="Any delivery notes..." {...register('specialInstructions')} />

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Place Order</Button>
        </div>
      </form>
    </Modal>
  );
}
