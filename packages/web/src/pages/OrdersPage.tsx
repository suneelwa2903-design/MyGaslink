import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlinePencilSquare,
  HiOutlineTruck,
  HiOutlineCheckCircle,
  HiOutlineMagnifyingGlass,
  HiOutlineTrash,
  HiOutlineArrowUturnLeft,
} from 'react-icons/hi2';
import {
  type Order,
  type Customer,
  type CylinderType,
  type Driver,
  type Vehicle,
  type PaginationMeta,
  OrderStatus,
  createOrderSchema,
  type CreateOrderInput,
  assignDriverSchema,
  type AssignDriverInput,
  deliveryConfirmationSchema,
  type DeliveryConfirmationInput,
  returnsOnlyOrderSchema,
  type ReturnsOnlyOrderInput,
} from '@gaslink/shared';
import { apiGet, apiPost, apiPut, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';

const STATUS_VARIANTS: Record<string, 'info' | 'warning' | 'success' | 'danger' | 'neutral'> = {
  [OrderStatus.PENDING_DRIVER_ASSIGNMENT]: 'warning',
  [OrderStatus.PENDING_DISPATCH]: 'info',
  [OrderStatus.PENDING_DELIVERY]: 'info',
  [OrderStatus.DELIVERED]: 'success',
  [OrderStatus.MODIFIED_DELIVERED]: 'success',
  [OrderStatus.CANCELLED]: 'danger',
};

const STATUS_LABELS: Record<string, string> = {
  [OrderStatus.PENDING_DRIVER_ASSIGNMENT]: 'Pending Assignment',
  [OrderStatus.PENDING_DISPATCH]: 'Pending Dispatch',
  [OrderStatus.PENDING_DELIVERY]: 'Pending Delivery',
  [OrderStatus.DELIVERED]: 'Delivered',
  [OrderStatus.MODIFIED_DELIVERED]: 'Modified Delivered',
  [OrderStatus.CANCELLED]: 'Cancelled',
};

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
}

export default function OrdersPage() {
  useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split('T')[0]);
  const [createOpen, setCreateOpen] = useState(false);
  const [returnsOpen, setReturnsOpen] = useState(false);
  const [editOrder, setEditOrder] = useState<Order | null>(null);
  const [assignOrder, setAssignOrder] = useState<Order | null>(null);
  const [deliverOrder, setDeliverOrder] = useState<Order | null>(null);
  const [selectedOrders, setSelectedOrders] = useState<string[]>([]);
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);

  const queryParams: Record<string, unknown> = { page, pageSize: 25 };
  if (search) queryParams.search = search;
  if (statusFilter) queryParams.status = statusFilter;
  if (dateFrom) queryParams.dateFrom = dateFrom;
  if (dateTo) queryParams.dateTo = dateTo;

  const { data, isLoading } = useQuery({
    queryKey: ['orders', queryParams],
    queryFn: () => apiGet<{ orders: Order[]; meta: PaginationMeta }>('/orders', queryParams),
  });

  const { data: customers } = useQuery({
    queryKey: ['customers-list'],
    queryFn: () => apiGet<{ customers: Customer[] }>('/customers', { pageSize: 100 }),
    staleTime: 5 * 60 * 1000,
  });

  const { data: cylinderTypes } = useQuery({
    queryKey: ['cylinder-types'],
    queryFn: () => apiGet<{ cylinderTypes: CylinderType[] }>('/cylinder-types'),
    select: (data) => data.cylinderTypes,
    staleTime: 10 * 60 * 1000,
  });

  const { data: drivers } = useQuery({
    queryKey: ['drivers-list'],
    queryFn: () => apiGet<{ drivers: Driver[] }>('/drivers', { status: 'active' }),
    staleTime: 5 * 60 * 1000,
  });

  // Vehicles list kept warm for the Order Detail / Delivery modals (those
  // still surface the day's assigned vehicle); the assign-driver flow no
  // longer needs it.
  useQuery({
    queryKey: ['vehicles-list'],
    queryFn: () => apiGet<{ vehicles: Vehicle[] }>('/vehicles', { status: 'idle' }),
    staleTime: 5 * 60 * 1000,
  });

  const orders = data?.orders ?? [];
  const meta = data?.meta;

  const toggleSelectOrder = (orderId: string) => {
    setSelectedOrders((prev) =>
      prev.includes(orderId) ? prev.filter((id) => id !== orderId) : [...prev, orderId],
    );
  };

  const statusOptions = Object.values(OrderStatus).map((s) => ({
    value: s,
    label: STATUS_LABELS[s] || s,
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Orders</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
            Manage orders and deliveries
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectedOrders.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => setBulkAssignOpen(true)}>
              <HiOutlineTruck className="h-4 w-4" />
              Assign Driver ({selectedOrders.length})
            </Button>
          )}
          <Button variant="secondary" onClick={() => setReturnsOpen(true)}>
            <HiOutlineArrowUturnLeft className="h-4 w-4" />
            Returns Order
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <HiOutlinePlus className="h-4 w-4" />
            New Order
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="relative lg:col-span-2">
            <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-400" />
            <input
              type="text"
              placeholder="Search orders..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="input pl-9 py-2"
            />
          </div>
          <Select
            options={statusOptions}
            placeholder="All Statuses"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
            className="input py-2"
            placeholder="From"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
            className="input py-2"
            placeholder="To"
          />
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : orders.length === 0 ? (
        <EmptyState
          title="No orders found"
          description="Create your first order to get started."
          action={<Button onClick={() => setCreateOpen(true)}><HiOutlinePlus className="h-4 w-4" />New Order</Button>}
        />
      ) : (
        <>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-8">
                    <input
                      type="checkbox"
                      checked={selectedOrders.length === orders.length && orders.length > 0}
                      onChange={(e) => setSelectedOrders(e.target.checked ? orders.map((o) => o.orderId) : [])}
                      className="rounded border-surface-300 dark:border-surface-600"
                    />
                  </th>
                  <th>Order #</th>
                  <th>Customer</th>
                  <th>Delivery Date</th>
                  <th>Items</th>
                  <th>Amount</th>
                  <th>Driver</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.orderId}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedOrders.includes(order.orderId)}
                        onChange={() => toggleSelectOrder(order.orderId)}
                        className="rounded border-surface-300 dark:border-surface-600"
                      />
                    </td>
                    <td className="font-medium text-surface-900 dark:text-white">{order.orderNumber}</td>
                    <td>{order.customerName}</td>
                    <td>{new Date(order.deliveryDate).toLocaleDateString('en-IN')}</td>
                    <td>{order.items.length} items</td>
                    <td className="font-medium">{formatCurrency(order.totalAmount)}</td>
                    <td>{order.driverName || <span className="text-surface-400">Unassigned</span>}</td>
                    <td>
                      <Badge variant={STATUS_VARIANTS[order.status] || 'neutral'}>
                        {STATUS_LABELS[order.status] || order.status}
                      </Badge>
                    </td>
                    <td>
                      <div className="flex items-center gap-1">
                        {order.status === OrderStatus.PENDING_DRIVER_ASSIGNMENT && (
                          <button
                            onClick={() => setAssignOrder(order)}
                            className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500"
                            title="Assign Driver"
                          >
                            <HiOutlineTruck className="h-4 w-4" />
                          </button>
                        )}
                        {(order.status === OrderStatus.PENDING_DELIVERY || order.status === OrderStatus.PENDING_DISPATCH) && (
                          <button
                            onClick={() => setDeliverOrder(order)}
                            className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-accent-500"
                            title="Confirm Delivery"
                          >
                            <HiOutlineCheckCircle className="h-4 w-4" />
                          </button>
                        )}
                        {order.status !== OrderStatus.DELIVERED && order.status !== OrderStatus.CANCELLED && (
                          <button
                            onClick={() => setEditOrder(order)}
                            className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-500"
                            title="Edit"
                          >
                            <HiOutlinePencilSquare className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {meta && meta.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-surface-500 dark:text-surface-400">
                Showing {(meta.page - 1) * meta.pageSize + 1}-{Math.min(meta.page * meta.pageSize, meta.total)} of {meta.total}
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <Button variant="secondary" size="sm" disabled={page >= meta.totalPages} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Create Order Modal */}
      {createOpen && (
        <CreateOrderModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          customers={customers?.customers ?? []}
          cylinderTypes={cylinderTypes ?? []}
        />
      )}

      {/* Returns Order Modal */}
      {returnsOpen && (
        <ReturnsOrderModal
          open={returnsOpen}
          onClose={() => setReturnsOpen(false)}
          customers={customers?.customers ?? []}
          cylinderTypes={cylinderTypes ?? []}
        />
      )}

      {/* Assign Driver Modal */}
      {assignOrder && (
        <AssignDriverModal
          open={!!assignOrder}
          onClose={() => setAssignOrder(null)}
          order={assignOrder}
          drivers={drivers?.drivers ?? []}
        />
      )}

      {/* Bulk Assign Driver Modal */}
      {bulkAssignOpen && (
        <BulkAssignDriverModal
          open={bulkAssignOpen}
          onClose={() => { setBulkAssignOpen(false); setSelectedOrders([]); }}
          orderIds={selectedOrders}
          drivers={drivers?.drivers ?? []}
        />
      )}

      {/* Delivery Confirmation Modal */}
      {deliverOrder && (
        <DeliveryConfirmationModal
          open={!!deliverOrder}
          onClose={() => setDeliverOrder(null)}
          order={deliverOrder}
        />
      )}

      {/* Edit Order Modal */}
      {editOrder && (
        <EditOrderModal
          open={!!editOrder}
          onClose={() => setEditOrder(null)}
          order={editOrder}
          cylinderTypes={cylinderTypes ?? []}
        />
      )}
    </div>
  );
}

// ─── Create Order Modal ──────────────────────────────────────────────────────

function CreateOrderModal({
  open,
  onClose,
  customers,
  cylinderTypes,
}: {
  open: boolean;
  onClose: () => void;
  customers: Customer[];
  cylinderTypes: CylinderType[];
}) {
  const queryClient = useQueryClient();

  const { register, handleSubmit, control, formState: { errors } } = useForm<CreateOrderInput>({
    resolver: zodResolver(createOrderSchema),
    defaultValues: {
      customerId: '',
      deliveryDate: new Date().toISOString().split('T')[0],
      specialInstructions: '',
      items: [{ cylinderTypeId: '', quantity: 1 }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  const mutation = useMutation({
    mutationFn: (data: CreateOrderInput) => apiPost('/orders', data),
    onSuccess: () => {
      toast.success('Order created successfully');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const customerOptions = customers.map((c) => ({ value: c.customerId, label: c.customerName }));
  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: `${ct.typeName} (${ct.capacity}${ct.unit})` }));

  return (
    <Modal open={open} onClose={onClose} title="Create Order" size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Select
          label="Customer"
          options={customerOptions}
          placeholder="Select customer"
          required
          error={errors.customerId?.message}
          {...register('customerId')}
        />

        <Input
          label="Delivery Date"
          type="date"
          required
          error={errors.deliveryDate?.message}
          {...register('deliveryDate')}
        />

        <div>
          <label className="label">Order Items</label>
          <div className="space-y-3">
            {fields.map((field, index) => (
              <div key={field.id} className="flex items-start gap-2">
                <div className="flex-1">
                  <Select
                    options={cylinderOptions}
                    placeholder="Select cylinder"
                    required
                    error={errors.items?.[index]?.cylinderTypeId?.message}
                    {...register(`items.${index}.cylinderTypeId`)}
                  />
                </div>
                <div className="w-24">
                  <Input
                    type="number"
                    placeholder="Qty"
                    min={1}
                    required
                    error={errors.items?.[index]?.quantity?.message}
                    {...register(`items.${index}.quantity`, { valueAsNumber: true })}
                  />
                </div>
                {fields.length > 1 && (
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    className="mt-1 p-2 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
                  >
                    <HiOutlineTrash className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          {errors.items?.message && <p className="error-text">{errors.items.message}</p>}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => append({ cylinderTypeId: '', quantity: 1 })}
          >
            <HiOutlinePlus className="h-3 w-3" />
            Add Item
          </Button>
        </div>

        <Input
          label="Special Instructions"
          placeholder="Optional notes..."
          error={errors.specialInstructions?.message}
          {...register('specialInstructions')}
        />

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Create Order</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Edit Order Modal ────────────────────────────────────────────────────────

function EditOrderModal({
  open,
  onClose,
  order,
  cylinderTypes,
}: {
  open: boolean;
  onClose: () => void;
  order: Order;
  cylinderTypes: CylinderType[];
}) {
  const queryClient = useQueryClient();

  const { register, handleSubmit, control, formState: { errors } } = useForm({
    defaultValues: {
      deliveryDate: order.deliveryDate,
      specialInstructions: order.specialInstructions || '',
      items: order.items.map((i) => ({
        cylinderTypeId: i.cylinderTypeId,
        quantity: i.quantity,
      })),
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  const mutation = useMutation({
    mutationFn: (data: { deliveryDate?: string; specialInstructions?: string; items?: { cylinderTypeId: string; quantity: number }[] }) =>
      apiPut(`/orders/${order.orderId}`, data),
    onSuccess: () => {
      toast.success('Order updated successfully');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: `${ct.typeName} (${ct.capacity}${ct.unit})` }));

  return (
    <Modal open={open} onClose={onClose} title={`Edit Order ${order.orderNumber}`} size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Input
          label="Delivery Date"
          type="date"
          error={errors.deliveryDate?.message}
          {...register('deliveryDate')}
        />

        <div>
          <label className="label">Order Items</label>
          <div className="space-y-3">
            {fields.map((field, index) => (
              <div key={field.id} className="flex items-start gap-2">
                <div className="flex-1">
                  <Select
                    options={cylinderOptions}
                    placeholder="Select cylinder"
                    required
                    error={errors.items?.[index]?.cylinderTypeId?.message}
                    {...register(`items.${index}.cylinderTypeId`)}
                  />
                </div>
                <div className="w-24">
                  <Input
                    type="number"
                    placeholder="Qty"
                    min={1}
                    required
                    error={errors.items?.[index]?.quantity?.message}
                    {...register(`items.${index}.quantity`, { valueAsNumber: true })}
                  />
                </div>
                {fields.length > 1 && (
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    className="mt-1 p-2 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
                  >
                    <HiOutlineTrash className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => append({ cylinderTypeId: '', quantity: 1 })}
          >
            <HiOutlinePlus className="h-3 w-3" />
            Add Item
          </Button>
        </div>

        <Input
          label="Special Instructions"
          placeholder="Optional notes..."
          {...register('specialInstructions')}
        />

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Update Order</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Assign Driver Modal ────────────────────────────────────────────────────

function AssignDriverModal({
  open,
  onClose,
  order,
  drivers,
}: {
  open: boolean;
  onClose: () => void;
  order: Order;
  drivers: Driver[];
}) {
  const queryClient = useQueryClient();

  // Vehicle is auto-resolved server-side from the day's driver-vehicle
  // assignment (orderService.assignDriver). The user only chooses the driver.
  const { register, handleSubmit, formState: { errors } } = useForm<AssignDriverInput>({
    resolver: zodResolver(assignDriverSchema),
    defaultValues: { driverId: '' },
  });

  const mutation = useMutation({
    mutationFn: (data: AssignDriverInput) => apiPost(`/orders/${order.orderId}/assign-driver`, data),
    onSuccess: () => {
      toast.success('Driver assigned successfully');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const driverOptions = drivers.map((d) => ({ value: d.driverId, label: `${d.driverName} (${d.phone})` }));

  return (
    <Modal open={open} onClose={onClose} title={`Assign Driver - ${order.orderNumber}`}>
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Select
          label="Driver"
          options={driverOptions}
          placeholder="Select driver"
          required
          error={errors.driverId?.message}
          {...register('driverId')}
        />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Assign</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Bulk Assign Driver Modal ────────────────────────────────────────────────

function BulkAssignDriverModal({
  open,
  onClose,
  orderIds,
  drivers,
}: {
  open: boolean;
  onClose: () => void;
  orderIds: string[];
  drivers: Driver[];
}) {
  const queryClient = useQueryClient();

  // See AssignDriverModal — vehicle is auto-resolved server-side.
  const { register, handleSubmit, formState: { errors } } = useForm({
    defaultValues: { driverId: '' },
  });

  const mutation = useMutation({
    mutationFn: (data: { driverId: string }) =>
      apiPost('/orders/bulk-assign-driver', { orderIds, ...data }),
    onSuccess: () => {
      toast.success(`Driver assigned to ${orderIds.length} orders`);
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const driverOptions = drivers.map((d) => ({ value: d.driverId, label: `${d.driverName} (${d.phone})` }));

  return (
    <Modal open={open} onClose={onClose} title={`Bulk Assign Driver (${orderIds.length} orders)`}>
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Select
          label="Driver"
          options={driverOptions}
          placeholder="Select driver"
          required
          error={errors.driverId?.message}
          {...register('driverId', { required: 'Driver is required' })}
        />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Assign to All</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Delivery Confirmation Modal ─────────────────────────────────────────────

function DeliveryConfirmationModal({
  open,
  onClose,
  order,
}: {
  open: boolean;
  onClose: () => void;
  order: Order;
}) {
  const queryClient = useQueryClient();

  const { register, handleSubmit, formState: { errors } } = useForm<DeliveryConfirmationInput>({
    resolver: zodResolver(deliveryConfirmationSchema),
    defaultValues: {
      items: order.items.map((item) => ({
        cylinderTypeId: item.cylinderTypeId,
        deliveredQuantity: item.quantity,
        emptiesCollected: 0,
      })),
      notes: '',
    },
  });

  const mutation = useMutation({
    mutationFn: (data: DeliveryConfirmationInput) =>
      apiPost(`/orders/${order.orderId}/confirm-delivery`, data),
    onSuccess: () => {
      toast.success('Delivery confirmed');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <Modal open={open} onClose={onClose} title={`Confirm Delivery - ${order.orderNumber}`} size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <div className="space-y-3">
          {order.items.map((item, index) => (
            <div key={item.orderItemId} className="p-4 bg-surface-50 dark:bg-surface-800/50 rounded-xl space-y-3">
              <p className="font-medium text-surface-900 dark:text-white">
                {item.cylinderTypeName} (Ordered: {item.quantity})
              </p>
              <input type="hidden" {...register(`items.${index}.cylinderTypeId`)} />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Delivered Qty"
                  type="number"
                  min={0}
                  required
                  error={errors.items?.[index]?.deliveredQuantity?.message}
                  {...register(`items.${index}.deliveredQuantity`, { valueAsNumber: true })}
                />
                <Input
                  label="Empties Collected"
                  type="number"
                  min={0}
                  required
                  error={errors.items?.[index]?.emptiesCollected?.message}
                  {...register(`items.${index}.emptiesCollected`, { valueAsNumber: true })}
                />
              </div>
            </div>
          ))}
        </div>

        <Input
          label="Delivery Notes"
          placeholder="Optional notes..."
          {...register('notes')}
        />

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending} variant="accent">
            <HiOutlineCheckCircle className="h-4 w-4" />
            Confirm Delivery
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Returns Order Modal ─────────────────────────────────────────────────────

function ReturnsOrderModal({
  open,
  onClose,
  customers,
  cylinderTypes,
}: {
  open: boolean;
  onClose: () => void;
  customers: Customer[];
  cylinderTypes: CylinderType[];
}) {
  const queryClient = useQueryClient();

  const { register, handleSubmit, control, formState: { errors } } = useForm<ReturnsOnlyOrderInput>({
    resolver: zodResolver(returnsOnlyOrderSchema),
    defaultValues: {
      customerId: '',
      scheduledDate: new Date().toISOString().split('T')[0],
      specialInstructions: '',
      items: [{ cylinderTypeId: '', expectedQuantity: 1 }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  const mutation = useMutation({
    mutationFn: (data: ReturnsOnlyOrderInput) => apiPost('/orders/returns-only', data),
    onSuccess: () => {
      toast.success('Returns order created successfully');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const customerOptions = customers.map((c) => ({ value: c.customerId, label: c.customerName }));
  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: `${ct.typeName} (${ct.capacity}${ct.unit})` }));

  return (
    <Modal open={open} onClose={onClose} title="Create Returns Order" size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Select
          label="Customer"
          options={customerOptions}
          placeholder="Select customer"
          required
          error={errors.customerId?.message}
          {...register('customerId')}
        />

        <Input
          label="Scheduled Date"
          type="date"
          required
          error={errors.scheduledDate?.message}
          {...register('scheduledDate')}
        />

        <div>
          <label className="label">Return Items</label>
          <div className="space-y-3">
            {fields.map((field, index) => (
              <div key={field.id} className="flex items-start gap-2">
                <div className="flex-1">
                  <Select
                    options={cylinderOptions}
                    placeholder="Select cylinder"
                    required
                    error={errors.items?.[index]?.cylinderTypeId?.message}
                    {...register(`items.${index}.cylinderTypeId`)}
                  />
                </div>
                <div className="w-24">
                  <Input
                    type="number"
                    placeholder="Qty"
                    min={1}
                    required
                    error={errors.items?.[index]?.expectedQuantity?.message}
                    {...register(`items.${index}.expectedQuantity`, { valueAsNumber: true })}
                  />
                </div>
                {fields.length > 1 && (
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    className="mt-1 p-2 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
                  >
                    <HiOutlineTrash className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          {errors.items?.message && <p className="error-text">{errors.items.message}</p>}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => append({ cylinderTypeId: '', expectedQuantity: 1 })}
          >
            <HiOutlinePlus className="h-3 w-3" />
            Add Item
          </Button>
        </div>

        <Input
          label="Special Instructions"
          placeholder="Optional notes..."
          error={errors.specialInstructions?.message}
          {...register('specialInstructions')}
        />

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Create Returns Order</Button>
        </div>
      </form>
    </Modal>
  );
}
