import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray, useWatch } from 'react-hook-form';
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
  HiOutlineEye,
  HiOutlineXCircle,
} from 'react-icons/hi2';
import {
  type Order,
  type CylinderType,
  type Driver,
  type Vehicle,
  type PaginationMeta,
  OrderStatus,
  OrderType,
  UserRole,
  createOrderSchema,
  backdatedOrderSchema,
  type BackdatedOrderInput,
  type CreateOrderInput,
  assignDriverSchema,
  type AssignDriverInput,
  deliveryConfirmationSchema,
  type DeliveryConfirmationInput,
  returnsOnlyOrderSchema,
  type ReturnsOnlyOrderInput,
  ORDER_STATUS_LABELS,
  orderStatusLabel,
  orderStatusVariant,
  localTodayISO,
  localDateISO,
} from '@gaslink/shared';
import { api, apiGet, apiPost, apiPut, getErrorMessage } from '@/lib/api';
import { useAuthStore, selectRole } from '@/stores/authStore';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState, CustomerSearchInput } from '@/components/ui';
import { LoadListDispatchModal } from '@/components/LoadListDispatchModal';
import { cn } from '@/lib/cn';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
}

export default function OrdersPage() {
  useQueryClient();
  // Driver Assignment moved here from the Fleet page — it's an Orders-side
  // morning workflow. Tab is available to admins AND inventory (the
  // morning depot dispatch is an inventory task). Driver role sees only
  // the Orders tab.
  const role = useAuthStore(selectRole);
  const canAssignDrivers =
    role === UserRole.DISTRIBUTOR_ADMIN ||
    role === UserRole.SUPER_ADMIN ||
    role === UserRole.FINANCE ||
    role === UserRole.INVENTORY;
  // Read ?tab= so other pages (e.g. the AssignmentModal empty state)
  // can deep-link straight into the Driver Assignment tab.
  const [searchParams] = useSearchParams();
  const initialOrdersTab = (searchParams.get('tab') === 'assignment' && canAssignDrivers)
    ? 'assignment' as const
    : 'orders' as const;
  const [tab, setTab] = useState<'orders' | 'assignment'>(initialOrdersTab);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return localDateISO(d);
  });
  const [dateTo, setDateTo] = useState(() => localTodayISO());
  const [createOpen, setCreateOpen] = useState(false);
  const [returnsOpen, setReturnsOpen] = useState(false);
  // Brief 3: distributor_admin-only on-demand backdated order modal.
  const [backdatedOpen, setBackdatedOpen] = useState(false);
  const [editOrder, setEditOrder] = useState<Order | null>(null);
  const [viewOrder, setViewOrder] = useState<Order | null>(null);
  const [assignOrder, setAssignOrder] = useState<Order | null>(null);
  const [deliverOrder, setDeliverOrder] = useState<Order | null>(null);
  const [selectedOrders, setSelectedOrders] = useState<string[]>([]);
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [cancelOrderTarget, setCancelOrderTarget] = useState<Order | null>(null);

  const queryParams: Record<string, unknown> = { page, pageSize: 25 };
  if (search) queryParams.search = search;
  if (statusFilter) queryParams.status = statusFilter;
  if (dateFrom) queryParams.dateFrom = dateFrom;
  if (dateTo) queryParams.dateTo = dateTo;

  const { data, isLoading } = useQuery({
    queryKey: ['orders', queryParams],
    queryFn: () => apiGet<{ orders: Order[]; meta: PaginationMeta }>('/orders', queryParams),
  });

  // Customers are loaded on-demand via the CustomerSearchInput component
  // inside Create/Returns modals — no preload. This avoids capping the
  // dropdown at the API's max pageSize and silently hiding customers from
  // the order-creation flow once a distributor crosses that threshold.

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
  // longer needs it. The backdated-order modal (distributor_admin only)
  // also reads this — vehicle is optional there, but when picked drives
  // EWB generation post-commit.
  const { data: vehicles } = useQuery({
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
    label: ORDER_STATUS_LABELS[s] || s,
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
        {tab === 'orders' && (
          <div className="flex items-center gap-2">
            {(() => {
              // Only count selected orders that are actually pending assignment.
              // Delivered/cancelled/dispatched orders in the selection are
              // ignored — they can't be re-assigned, so showing a count that
              // includes them misleads the admin.
              const assignablePendingIds = selectedOrders.filter((id) => {
                const o = orders.find((order) => order.orderId === id);
                return o?.status === OrderStatus.PENDING_DRIVER_ASSIGNMENT;
              });
              if (assignablePendingIds.length === 0) return null;
              return (
                <Button variant="secondary" size="sm" onClick={() => setBulkAssignOpen(true)}>
                  <HiOutlineTruck className="h-4 w-4" />
                  Assign Driver ({assignablePendingIds.length})
                </Button>
              );
            })()}
            <Button variant="secondary" onClick={() => setReturnsOpen(true)}>
              <HiOutlineArrowUturnLeft className="h-4 w-4" />
              Returns Order
            </Button>
            {role === UserRole.DISTRIBUTOR_ADMIN && (
              <Button variant="secondary" onClick={() => setBackdatedOpen(true)}>
                <HiOutlinePlus className="h-4 w-4" />
                Backdated Order
              </Button>
            )}
            <Button onClick={() => setCreateOpen(true)}>
              <HiOutlinePlus className="h-4 w-4" />
              New Order
            </Button>
          </div>
        )}
      </div>

      {/* Tabs — Orders | Driver Assignment (admins only) */}
      {canAssignDrivers && (
        <div className="border-b border-surface-200 dark:border-surface-700">
          <div className="flex gap-4">
            {([
              { key: 'orders' as const, label: 'Orders' },
              { key: 'assignment' as const, label: 'Driver Assignment' },
            ]).map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  'pb-2 text-sm font-medium border-b-2 transition-colors',
                  tab === t.key
                    ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                    : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'assignment' && canAssignDrivers && <AssignmentsTab />}

      {tab === 'orders' && (
       <>
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
                    <td>
                      {order.driverName ? (
                        order.driverName
                      ) : order.isGodownPickup ? (
                        <span className="text-surface-400" title="Customer self-collects from godown">
                          N/A — Godown
                        </span>
                      ) : (
                        <span className="text-surface-400">Unassigned</span>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant={orderStatusVariant(order.status)}>
                          {orderStatusLabel(order.status)}
                        </Badge>
                        {order.isBackdated && (
                          <span title="On-demand entry for a delivery that already happened">
                            <Badge variant="warning">Backdated</Badge>
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setViewOrder(order)}
                          className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-500"
                          title="View"
                        >
                          <HiOutlineEye className="h-4 w-4" />
                        </button>
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
                        {(order.status === OrderStatus.PENDING_DRIVER_ASSIGNMENT || order.status === OrderStatus.PENDING_DISPATCH) && (
                          <button
                            onClick={() => setEditOrder(order)}
                            className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-500"
                            title="Edit"
                          >
                            <HiOutlinePencilSquare className="h-4 w-4" />
                          </button>
                        )}
                        {canAssignDrivers && [
                          OrderStatus.PENDING_DRIVER_ASSIGNMENT,
                          OrderStatus.PENDING_DISPATCH,
                          OrderStatus.PENDING_DELIVERY,
                          OrderStatus.PREFLIGHT_IN_PROGRESS,
                        ].includes(order.status) && (
                          <button
                            onClick={() => setCancelOrderTarget(order)}
                            className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-red-500"
                            title="Cancel Order"
                          >
                            <HiOutlineXCircle className="h-4 w-4" />
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
       </>
      )}

      {/* Create Order Modal */}
      {createOpen && (
        <CreateOrderModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          cylinderTypes={cylinderTypes ?? []}
        />
      )}

      {/* Returns Order Modal */}
      {returnsOpen && (
        <ReturnsOrderModal
          open={returnsOpen}
          onClose={() => setReturnsOpen(false)}
          cylinderTypes={cylinderTypes ?? []}
        />
      )}

      {/* Brief 3 — Backdated Order Modal (distributor_admin only) */}
      {backdatedOpen && (
        <BackdatedOrderModal
          open={backdatedOpen}
          onClose={() => setBackdatedOpen(false)}
          cylinderTypes={cylinderTypes ?? []}
          drivers={drivers?.drivers ?? []}
          vehicles={vehicles?.vehicles ?? []}
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

      {/* Bulk Assign Driver Modal — only pass pending-assignment IDs.
          The header button is hidden unless at least one selection is pending,
          and including non-pending ids would hit the API's 400 "Order is not
          in a state that allows driver assignment". */}
      {bulkAssignOpen && (
        <BulkAssignDriverModal
          open={bulkAssignOpen}
          onClose={() => { setBulkAssignOpen(false); setSelectedOrders([]); }}
          orderIds={selectedOrders.filter((id) => {
            const o = orders.find((order) => order.orderId === id);
            return o?.status === OrderStatus.PENDING_DRIVER_ASSIGNMENT;
          })}
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

      {/* View Order Modal — read-only, available for every status incl. delivered/cancelled */}
      {viewOrder && (
        <OrderDetailModal
          open={!!viewOrder}
          onClose={() => setViewOrder(null)}
          order={viewOrder}
        />
      )}

      {/* Cancel Order Modal */}
      {cancelOrderTarget && (
        <CancelOrderModal
          open={!!cancelOrderTarget}
          onClose={() => setCancelOrderTarget(null)}
          order={cancelOrderTarget}
        />
      )}
    </div>
  );
}

// ─── Create Order Modal ──────────────────────────────────────────────────────

function CreateOrderModal({
  open,
  onClose,
  cylinderTypes,
}: {
  open: boolean;
  onClose: () => void;
  cylinderTypes: CylinderType[];
}) {
  const queryClient = useQueryClient();

  const { register, handleSubmit, control, setValue, watch, formState: { errors } } = useForm<CreateOrderInput>({
    resolver: zodResolver(createOrderSchema),
    defaultValues: {
      customerId: '',
      // Phase D (2026-06-12): local TZ.
      deliveryDate: localTodayISO(),
      specialInstructions: '',
      poNumber: '',
      isGodownPickup: false,
      items: [{ cylinderTypeId: '', quantity: 1 }],
    },
  });
  const isGodownPickup = watch('isGodownPickup');

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  // Track the picked customer's type so the PO input is gated on B2B. The
  // CustomerSearchInput onChange passes the full Customer object; we keep
  // just the type locally (avoids re-fetching). Cleared on Clear-selection.
  const [selectedCustomerType, setSelectedCustomerType] = useState<'B2B' | 'B2C' | null>(null);

  const mutation = useMutation({
    mutationFn: (data: CreateOrderInput) => apiPost('/orders', data),
    onSuccess: () => {
      toast.success('Order created successfully');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: `${ct.typeName} (${ct.capacity}${ct.unit})` }));
  // useWatch (not watch()) — react-hook-form's watch() function returns a
  // non-stable subscription callable that React Compiler can't safely
  // memoize (rule: react-hooks/incompatible-library). useWatch returns
  // the subscribed value directly with a stable subscription identity.
  const customerId = useWatch({ control, name: 'customerId' });

  return (
    <Modal open={open} onClose={onClose} title="Create Order" size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <CustomerSearchInput
          label="Customer"
          required
          value={customerId}
          onChange={(id, customer) => {
            setValue('customerId', id, { shouldValidate: true });
            // Empty id ⇒ user cleared the selection ⇒ drop the cached type
            // so the PO field hides immediately (anti-pattern #18 cohesion:
            // dependent UI state invalidates with its source).
            setSelectedCustomerType(id ? (customer?.customerType ?? null) : null);
          }}
          error={errors.customerId?.message}
        />

        <Input
          label="Delivery Date"
          type="date"
          required
          error={errors.deliveryDate?.message}
          {...register('deliveryDate')}
        />

        {selectedCustomerType === 'B2B' && (
          <Input
            label="PO Number"
            placeholder="Buyer's purchase order number"
            maxLength={16}
            error={errors.poNumber?.message}
            {...register('poNumber')}
          />
        )}

        <div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              {...register('isGodownPickup')}
              className="h-4 w-4 rounded border-surface-300 dark:border-surface-600"
            />
            <span className="text-sm font-medium text-surface-900 dark:text-white">
              Godown Pickup (customer self-collects)
            </span>
          </label>
          {isGodownPickup && (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-300">
              No driver will be assigned. Admin or finance confirms pickup after the customer collects. No e-Way Bill is generated.
            </div>
          )}
        </div>

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

// ─── Backdated Order Modal ───────────────────────────────────────────────────
// Brief 3 — distributor_admin-only on-demand order+invoice for deliveries
// that already happened. Two-step UX: first the GST document type
// (E-Invoice+EWB vs E-Invoice only, B2B only — auto-collapsed to invoice-
// only for B2C), then the order details with optional driver/vehicle and
// payment.
//
// Date picker constraints: localTodayISO()-derived min/max — same-month,
// before today. Anti-pattern #21 guard at the schema edge + service edge.

type BackdatedFormInput = BackdatedOrderInput & { recordPayment?: boolean };

function BackdatedOrderModal({
  open, onClose, cylinderTypes, drivers, vehicles,
}: {
  open: boolean;
  onClose: () => void;
  cylinderTypes: CylinderType[];
  drivers: Driver[];
  vehicles: Vehicle[];
}) {
  const queryClient = useQueryClient();
  // Step 1 = GST doc-type pick (B2B only). Step 2 = order details. B2C
  // auto-jumps to Step 2 with gstDocType locked to 'invoice_only'.
  const [step, setStep] = useState<1 | 2>(1);
  const [gstDocType, setGstDocType] = useState<'invoice_ewb' | 'invoice_only'>('invoice_ewb');
  const [selectedCustomerType, setSelectedCustomerType] = useState<'B2B' | 'B2C' | null>(null);

  // Local-TZ min/max for the date picker — never use toISOString().split('T')[0].
  const todayISO = localTodayISO();
  const monthStart = todayISO.slice(0, 8) + '01';
  // Max date = yesterday (todayISO − 1 day). Build via Date math but
  // serialise with localDateISO so the wire string stays in local TZ.
  const maxDateObj = new Date(todayISO + 'T12:00:00');
  maxDateObj.setDate(maxDateObj.getDate() - 1);
  const maxDateISO = localDateISO(maxDateObj);
  // Defensive: if today is the 1st of the month there's no valid backdated
  // slot at all. The button still opens the modal so the operator sees the
  // explanation rather than a silent no-op.
  const noValidDates = maxDateISO < monthStart;

  const {
    register, handleSubmit, control, setValue, watch, formState: { errors },
  } = useForm<BackdatedFormInput>({
    resolver: zodResolver(backdatedOrderSchema),
    defaultValues: {
      customerId: '',
      issueDate: maxDateISO,
      items: [{ cylinderTypeId: '', quantity: 1 }],
      specialInstructions: '',
      poNumber: '',
      driverId: undefined,
      vehicleId: undefined,
      payment: undefined,
      recordPayment: false,
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'items' });
  const customerId = useWatch({ control, name: 'customerId' });
  const recordPayment = watch('recordPayment');
  const driverId = watch('driverId');
  const vehicleId = watch('vehicleId');

  const mutation = useMutation({
    mutationFn: (data: BackdatedOrderInput) => apiPost('/orders/backdated', data),
    onSuccess: () => {
      toast.success('Backdated order created');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const cylinderOptions = cylinderTypes.map((ct) => ({
    value: ct.cylinderTypeId, label: `${ct.typeName} (${ct.capacity}${ct.unit})`,
  }));
  const driverOptions = drivers.map((d) => ({ value: d.driverId, label: d.driverName }));
  const vehicleOptions = vehicles.map((v) => ({ value: v.vehicleId, label: v.vehicleNumber }));

  const requiresVehicle = gstDocType === 'invoice_ewb';
  const showVehicleSection = selectedCustomerType === 'B2B' ? true : true; // always visible; required only on invoice_ewb

  const onSubmit = handleSubmit((data) => {
    // Strip the UI-only `recordPayment` flag + clear `payment` when not
    // toggled on. Also drop empty driver/vehicle so optional-uuid Zod
    // refines pass.
    const payload: BackdatedOrderInput = {
      customerId: data.customerId,
      issueDate: data.issueDate,
      items: data.items,
      specialInstructions: data.specialInstructions || undefined,
      poNumber: data.poNumber || undefined,
      driverId: data.driverId || undefined,
      vehicleId: data.vehicleId || undefined,
      payment: data.recordPayment && data.payment?.amount ? data.payment : undefined,
    };
    mutation.mutate(payload);
  });

  return (
    <Modal open={open} onClose={onClose} title="New Backdated Order" size="lg">
      <div className="space-y-4">
        <p className="text-xs text-surface-500 dark:text-surface-400">
          For deliveries already made but not yet billed. Status: <strong>Delivered</strong>.
          Inventory is NOT auto-adjusted — this is a paper-trail entry.
        </p>

        {/* STEP 1 — only meaningful for B2B. B2C jumps straight to Step 2. */}
        {step === 1 && selectedCustomerType !== 'B2C' && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-surface-700 dark:text-surface-300">
              Step 1 — GST document type
            </p>
            {/* Customer picker shown here so we know whether to auto-skip. */}
            <CustomerSearchInput
              label="Customer"
              required
              value={customerId}
              onChange={(id, customer) => {
                setValue('customerId', id, { shouldValidate: true });
                const t = id ? (customer?.customerType ?? null) : null;
                setSelectedCustomerType(t);
                if (t === 'B2C') {
                  setGstDocType('invoice_only');
                  setStep(2);
                }
              }}
              error={errors.customerId?.message}
            />
            {selectedCustomerType === 'B2B' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setGstDocType('invoice_ewb')}
                  className={cn(
                    'text-left rounded-lg border p-3 transition',
                    gstDocType === 'invoice_ewb'
                      ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10'
                      : 'border-surface-200 hover:border-surface-300 dark:border-surface-700',
                  )}
                >
                  <p className="text-sm font-medium">E-Invoice + EWB</p>
                  <p className="mt-1 text-xs text-surface-500">Vehicle + driver required. Generates IRN and EWB.</p>
                </button>
                <button
                  type="button"
                  onClick={() => setGstDocType('invoice_only')}
                  className={cn(
                    'text-left rounded-lg border p-3 transition',
                    gstDocType === 'invoice_only'
                      ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10'
                      : 'border-surface-200 hover:border-surface-300 dark:border-surface-700',
                  )}
                >
                  <p className="text-sm font-medium">E-Invoice Only</p>
                  <p className="mt-1 text-xs text-surface-500">No vehicle movement. Generates IRN only.</p>
                </button>
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button type="button" disabled={!customerId || !selectedCustomerType} onClick={() => setStep(2)}>
                Next →
              </Button>
            </div>
          </div>
        )}

        {/* STEP 2 — order details */}
        {step === 2 && (
          <form onSubmit={onSubmit} className="space-y-4">
            {/* Show the customer summary + step-1 selection so the operator can confirm. */}
            <div className="rounded-lg border border-surface-200 dark:border-surface-700 p-3 text-xs space-y-1">
              <p>
                <span className="text-surface-500">Customer:</span>{' '}
                <strong>{selectedCustomerType ?? '—'}</strong>
              </p>
              {selectedCustomerType === 'B2C' ? (
                <p className="text-surface-500">
                  B2C customer — IRN not applicable. EWB will be generated if vehicle is provided.
                </p>
              ) : (
                <p>
                  <span className="text-surface-500">GST:</span>{' '}
                  <strong>{gstDocType === 'invoice_ewb' ? 'E-Invoice + EWB' : 'E-Invoice Only'}</strong>
                </p>
              )}
              {selectedCustomerType !== 'B2C' && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setStep(1)} className="!p-0 !h-auto">
                  ← Change
                </Button>
              )}
            </div>

            {/* For B2C the customer picker is here — Step 1 was skipped. */}
            {selectedCustomerType !== 'B2B' && (
              <CustomerSearchInput
                label="Customer"
                required
                value={customerId}
                onChange={(id, customer) => {
                  setValue('customerId', id, { shouldValidate: true });
                  const t = id ? (customer?.customerType ?? null) : null;
                  setSelectedCustomerType(t);
                  if (t === 'B2B') {
                    // Reset to Step 1 so the operator picks doc-type explicitly.
                    setStep(1);
                  }
                }}
                error={errors.customerId?.message}
              />
            )}

            <div>
              <Input
                label="Delivery Date (backdated)"
                type="date"
                required
                min={monthStart}
                max={maxDateISO}
                error={errors.issueDate?.message}
                {...register('issueDate')}
              />
              <p className="mt-1 text-xs text-surface-500">
                {noValidDates
                  ? "Today is the 1st of the month — no valid backdated slot. Wait until tomorrow."
                  : `Must be between ${monthStart} and ${maxDateISO} (within the current month, before today).`}
              </p>
            </div>

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
                type="button" variant="ghost" size="sm" className="mt-2"
                onClick={() => append({ cylinderTypeId: '', quantity: 1 })}
              >
                <HiOutlinePlus className="h-3 w-3" /> Add Item
              </Button>
            </div>

            {selectedCustomerType === 'B2B' && (
              <Input
                label="PO Number"
                placeholder="Buyer's purchase order number"
                maxLength={16}
                error={errors.poNumber?.message}
                {...register('poNumber')}
              />
            )}

            {/* Driver + Vehicle: required on invoice_ewb, optional otherwise.
                For B2C, optional always — EWB still fires if vehicle picked. */}
            {showVehicleSection && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Select
                    label={requiresVehicle ? 'Driver' : 'Driver (optional)'}
                    options={driverOptions}
                    placeholder="—"
                    error={errors.driverId?.message ?? (requiresVehicle && !driverId ? 'Driver required for E-Invoice + EWB' : undefined)}
                    {...register('driverId')}
                  />
                </div>
                <div>
                  <Select
                    label={requiresVehicle ? 'Vehicle' : 'Vehicle (optional)'}
                    options={vehicleOptions}
                    placeholder="—"
                    error={errors.vehicleId?.message ?? (requiresVehicle && !vehicleId ? 'Vehicle required for E-Invoice + EWB' : undefined)}
                    {...register('vehicleId')}
                  />
                </div>
                {selectedCustomerType === 'B2C' && !requiresVehicle && (
                  <p className="sm:col-span-2 text-xs text-surface-500">
                    EWB will be generated if vehicle is provided.
                  </p>
                )}
              </div>
            )}

            <Input
              label="Special Instructions"
              placeholder="Optional notes…"
              error={errors.specialInstructions?.message}
              {...register('specialInstructions')}
            />

            {/* Payment toggle */}
            <div className="rounded-lg border border-surface-200 dark:border-surface-700 p-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" {...register('recordPayment')} className="h-4 w-4 rounded" />
                <span className="text-sm font-medium">Record payment received</span>
              </label>
              {recordPayment && (
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input
                    label="Amount"
                    type="number"
                    step="0.01"
                    min={0}
                    error={errors.payment?.amount?.message}
                    {...register('payment.amount', { valueAsNumber: true })}
                  />
                  <Select
                    label="Payment Method"
                    options={[
                      { value: 'cash', label: 'Cash' },
                      { value: 'upi', label: 'UPI' },
                      { value: 'cheque', label: 'Cheque' },
                      { value: 'neft', label: 'NEFT' },
                      { value: 'rtgs', label: 'RTGS' },
                      { value: 'other', label: 'Other' },
                    ]}
                    error={errors.payment?.paymentMethod?.message}
                    {...register('payment.paymentMethod')}
                  />
                  <Input
                    label="Reference"
                    placeholder="Transaction / cheque number"
                    error={errors.payment?.referenceNumber?.message}
                    {...register('payment.referenceNumber')}
                  />
                  <Input
                    label="Payment Date (optional)"
                    type="date"
                    max={maxDateISO}
                    error={errors.payment?.transactionDate?.message}
                    {...register('payment.transactionDate')}
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button type="submit" loading={mutation.isPending} disabled={noValidDates}>
                Create Backdated Order
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

// ─── Order Detail (View) Modal ───────────────────────────────────────────────
// Read-only view of an order. Used for delivered/cancelled orders (which
// have no edit/assign actions) and also as a quick lookup for orders in any
// status. No mutations here — it just reads from the order row already loaded
// by the list query.

function OrderDetailModal({
  open,
  onClose,
  order,
}: {
  open: boolean;
  onClose: () => void;
  order: Order;
}) {
  return (
    <Modal open={open} onClose={onClose} title={`Order ${order.orderNumber}`} size="lg">
      <div className="space-y-4 text-sm">
        {/* Brief 3 — backdated banner with the audit-trail entry timestamp. */}
        {order.isBackdated && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-300">
            <p className="font-semibold">Backdated — delivery recorded for {new Date(order.deliveryDate).toLocaleDateString('en-IN')}.</p>
            <p className="mt-1">Inventory not auto-updated. Entered on: {new Date(order.createdAt).toLocaleString('en-IN')}.</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-surface-500">Status</p>
            <Badge variant={orderStatusVariant(order.status)}>
              {orderStatusLabel(order.status)}
            </Badge>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-surface-500">Type</p>
            <p className="font-medium">{order.orderType}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-surface-500">Customer</p>
            <p className="font-medium">{order.customerName}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-surface-500">Delivery Date</p>
            <p className="font-medium">
              {order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString('en-IN') : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-surface-500">Driver</p>
            <p className="font-medium">
              {order.driverName || (order.isGodownPickup ? 'N/A — Godown' : '—')}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-surface-500">Vehicle</p>
            <p className="font-medium">
              {order.vehicleNumber || (order.isGodownPickup ? 'N/A — Godown' : '—')}
            </p>
          </div>
          {order.poNumber && (
            <div>
              <p className="text-xs uppercase tracking-wide text-surface-500">PO No.</p>
              <p className="font-medium">{order.poNumber}</p>
            </div>
          )}
          {order.isGodownPickup && (
            <div className="col-span-2">
              <Badge variant="warning">Godown Pickup — self-collection, no vehicle</Badge>
            </div>
          )}
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-surface-500 mb-2">Items</p>
          <div className="rounded-lg border border-surface-200 dark:border-surface-700 overflow-hidden">
            {/*
              WI-064: for delivered / modified_delivered orders the
              legacy Line Total read `unitPrice × quantity (ordered)`
              while the bottom Total showed delivered totalAmount —
              the two numbers contradicted each other when the driver
              picked up empties or handed over fewer cylinders. Expand
              to Ordered / Delivered / Empties / Line Total columns
              for completed orders so the math is internally consistent.
            */}
            {(() => {
              const showDelivered =
                order.status === 'delivered' || order.status === 'modified_delivered';
              return (
                <table className="w-full">
                  <thead className="bg-surface-50 dark:bg-surface-700">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium">Cylinder</th>
                      <th className="px-3 py-2 text-right text-xs font-medium">
                        {showDelivered ? 'Ordered' : 'Qty'}
                      </th>
                      {showDelivered && (
                        <>
                          <th className="px-3 py-2 text-right text-xs font-medium">Delivered</th>
                          <th className="px-3 py-2 text-right text-xs font-medium">Empties</th>
                        </>
                      )}
                      <th className="px-3 py-2 text-right text-xs font-medium">Unit Price</th>
                      <th className="px-3 py-2 text-right text-xs font-medium">Line Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-100 dark:divide-surface-700">
                    {order.items.map((item, idx) => {
                      // confirmDelivery writes deliveredQuantity on
                      // delivered orders; the fallback to `quantity` is
                      // a safety net for in-flight orders previewed in
                      // this same modal.
                      const deliveredQty = item.deliveredQuantity ?? item.quantity;
                      const empties = item.emptiesCollected ?? 0;
                      const unit = item.unitPrice ?? 0;
                      const billedQty = showDelivered ? deliveredQty : item.quantity;
                      const lineTotal = unit * billedQty;
                      return (
                        <tr key={idx}>
                          <td className="px-3 py-2">
                            {item.cylinderTypeName ?? item.cylinderTypeId}
                          </td>
                          <td className="px-3 py-2 text-right">{item.quantity}</td>
                          {showDelivered && (
                            <>
                              <td className="px-3 py-2 text-right">{deliveredQty}</td>
                              <td className="px-3 py-2 text-right">{empties}</td>
                            </>
                          )}
                          <td className="px-3 py-2 text-right">{formatCurrency(unit)}</td>
                          <td className="px-3 py-2 text-right font-medium">
                            {formatCurrency(lineTotal)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              );
            })()}
          </div>
        </div>

        <div className="flex justify-between border-t border-surface-200 dark:border-surface-700 pt-3">
          <span className="text-xs uppercase tracking-wide text-surface-500">Total</span>
          <span className="text-lg font-semibold">{formatCurrency(order.totalAmount ?? 0)}</span>
        </div>

        {order.specialInstructions && (
          <div>
            <p className="text-xs uppercase tracking-wide text-surface-500">Special Instructions</p>
            <p>{order.specialInstructions}</p>
          </div>
        )}

        <div className="flex justify-end pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
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
      // order.deliveryDate comes back as a full ISO datetime
      // ("2026-05-14T00:00:00.000Z"), but updateOrderSchema.deliveryDate
      // (and the <input type="date">) expect a bare YYYY-MM-DD. Without
      // this trim, an unedited date field submits the ISO string and the
      // PUT /orders/:id fails zod validation with a 400.
      deliveryDate: order.deliveryDate?.split('T')[0] ?? order.deliveryDate,
      specialInstructions: order.specialInstructions || '',
      poNumber: order.poNumber || '',
      items: order.items.map((i) => ({
        cylinderTypeId: i.cylinderTypeId,
        quantity: i.quantity,
      })),
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  const mutation = useMutation({
    mutationFn: (data: { deliveryDate?: string; specialInstructions?: string; poNumber?: string; items?: { cylinderTypeId: string; quantity: number }[] }) =>
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

        {order.customerType === 'B2B' && (
          <Input
            label="PO Number"
            placeholder="Buyer's purchase order number"
            maxLength={16}
            error={errors.poNumber?.message}
            {...register('poNumber')}
          />
        )}

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

  // WI-079 / Fix 3 — server-side `assignDriver` requires a confirmed
  // vehicle mapping for the order's delivery date. We surface ALL active
  // drivers in the dropdown (so the user always sees their roster) and
  // visually disable the ones with no vehicle today, marked "(no vehicle
  // today)". When the entire list has no vehicles, we render a helpful
  // empty-state pointing the user to Fleet → Vehicle Mapping instead of
  // an empty Select.
  const driverOptions = drivers.map((d) => ({
    value: d.driverId,
    label: d.vehicleNumber
      ? `${d.driverName} — ${d.vehicleNumber}`
      : `${d.driverName} — (no vehicle today)`,
    disabled: !d.vehicleNumber,
  }));
  const anyDriverHasVehicle = drivers.some((d) => d.vehicleNumber);

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
        {drivers.length === 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            No active drivers. Add a driver in Fleet → Drivers first.
          </p>
        ) : !anyDriverHasVehicle ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            None of your drivers have a confirmed vehicle for today. Set one in
            Fleet → Vehicle Mapping before assigning.
          </p>
        ) : null}
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

  // WI-079 / Fix 3 — see AssignDriverModal. Show all active drivers and
  // visually disable the ones without a vehicle today, so the dropdown is
  // never empty when drivers exist.
  const driverOptions = drivers.map((d) => ({
    value: d.driverId,
    label: d.vehicleNumber
      ? `${d.driverName} — ${d.vehicleNumber}`
      : `${d.driverName} — (no vehicle today)`,
    disabled: !d.vehicleNumber,
  }));
  const anyDriverHasVehicle = drivers.some((d) => d.vehicleNumber);

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
        {drivers.length === 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            No active drivers. Add a driver in Fleet → Drivers first.
          </p>
        ) : !anyDriverHasVehicle ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            None of your drivers have a confirmed vehicle for today. Set one in
            Fleet → Vehicle Mapping before assigning.
          </p>
        ) : null}
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
  // The same confirmation modal is reached for both delivery orders and
  // returns-only orders. Returns are the opposite of deliveries, so the
  // verbiage flips when orderType === returns_only.
  const isReturn = order.orderType === OrderType.RETURNS_ONLY;

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
      toast.success(isReturn ? 'Return confirmed' : 'Delivery confirmed');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${isReturn ? 'Confirm Return' : 'Confirm Delivery'} - ${order.orderNumber}`}
      size="lg"
    >
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <div className="space-y-3">
          {order.items.map((item, index) => (
            <div key={item.orderItemId} className="p-4 bg-surface-50 dark:bg-surface-800/50 rounded-xl space-y-3">
              <p className="font-medium text-surface-900 dark:text-white">
                {item.cylinderTypeName} ({isReturn ? 'Expected' : 'Ordered'}: {item.quantity})
              </p>
              <input type="hidden" {...register(`items.${index}.cylinderTypeId`)} />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label={isReturn ? 'Return Qty' : 'Delivered Qty'}
                  type="number"
                  min={0}
                  max={item.quantity}
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
          label={isReturn ? 'Return Notes' : 'Delivery Notes'}
          placeholder="Optional notes..."
          {...register('notes')}
        />

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending} variant="accent">
            <HiOutlineCheckCircle className="h-4 w-4" />
            {isReturn ? 'Confirm Return' : 'Confirm Delivery'}
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
  cylinderTypes,
}: {
  open: boolean;
  onClose: () => void;
  cylinderTypes: CylinderType[];
}) {
  const queryClient = useQueryClient();

  const { register, handleSubmit, control, setValue, formState: { errors } } = useForm<ReturnsOnlyOrderInput>({
    resolver: zodResolver(returnsOnlyOrderSchema),
    defaultValues: {
      customerId: '',
      // Phase D (2026-06-12): local TZ.
      scheduledDate: localTodayISO(),
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

  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: `${ct.typeName} (${ct.capacity}${ct.unit})` }));
  // useWatch (not watch()) — react-hook-form's watch() function returns a
  // non-stable subscription callable that React Compiler can't safely
  // memoize (rule: react-hooks/incompatible-library). useWatch returns
  // the subscribed value directly with a stable subscription identity.
  const customerId = useWatch({ control, name: 'customerId' });

  return (
    <Modal open={open} onClose={onClose} title="Create Returns Order" size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <CustomerSearchInput
          label="Customer"
          required
          value={customerId}
          onChange={(id) => setValue('customerId', id, { shouldValidate: true })}
          error={errors.customerId?.message}
        />

        <Input
          label="Return Date"
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

// ─── Cancel Order Modal ──────────────────────────────────────────────────────

function CancelOrderModal({
  open,
  onClose,
  order,
}: {
  open: boolean;
  onClose: () => void;
  order: Order;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      apiPost(`/orders/${order.orderId}/cancel`, { reason: 'Cancelled by admin' }),
    onSuccess: () => {
      toast.success('Order cancelled');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
    onError: (error) => {
      const msg = getErrorMessage(error);
      if (msg.toLowerCase().includes('payment')) {
        toast.error('Cannot cancel — this order has recorded payments. Handle the payment in Billing & Payments first.');
      } else {
        toast.error(msg);
      }
    },
  });

  const isPendingAssignment = order.status === 'pending_driver_assignment';

  return (
    <Modal open={open} onClose={onClose} title={`Cancel Order ${order.orderNumber}?`}>
      <div className="space-y-4 text-sm text-surface-700 dark:text-surface-300">
        {isPendingAssignment ? (
          <>
            <p>This will cancel the order.</p>
            <p>No invoice has been generated yet.</p>
            <p className="font-medium text-red-600 dark:text-red-400">This cannot be undone.</p>
          </>
        ) : (
          <>
            <p>This will:</p>
            <ul className="list-disc list-inside space-y-1 text-surface-600 dark:text-surface-400">
              <li>Cancel the order and return stock to depot</li>
              <li>Void the invoice</li>
              <li>Attempt to cancel EWB/IRN at NIC automatically</li>
            </ul>
            <p className="text-surface-500 dark:text-surface-400 text-xs">
              Note: If EWB/IRN cannot be cancelled (after 24h window), a pending action will be raised for manual handling.
            </p>
            <p className="font-medium text-red-600 dark:text-red-400">This cannot be undone.</p>
          </>
        )}
      </div>
      <div className="flex justify-end gap-3 pt-4">
        <Button type="button" variant="secondary" onClick={onClose}>Go Back</Button>
        <Button
          type="button"
          variant="danger"
          loading={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Cancel Order
        </Button>
      </div>
    </Modal>
  );
}

// ─── Driver Assignment Tab ───────────────────────────────────────────────────
// Pure order-to-driver assignment workflow (Concept B). Vehicle mappings
// (Concept A — which driver typically uses which vehicle) live in Fleet.
// Inline per-row dropdown for single assignment; checkboxes + toolbar
// dropdown for bulk assignment. Driver list comes from /drivers?status=active;
// vehicle is auto-resolved server-side from the day's mapping.

function AssignmentsTab() {
  const queryClient = useQueryClient();
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [bulkDriverId, setBulkDriverId] = useState('');
  const [dispatchDriver, setDispatchDriver] = useState<{
    driverId: string;
    driverName: string;
    vehicleNumber: string | null;
    assignmentId: string | null;
    orders: Order[];
    // WI-065: when this dispatch represents an Add-to-Trip flow, the
    // progress modal hits /preflight-add-to-trip instead of
    // /preflight-dispatch. The two endpoints share the same response
    // shape so the modal body is identical.
    mode?: 'new_trip' | 'add_to_trip';
  } | null>(null);

  // FLOAT-001 (Round 2): two-step Load List → Dispatch flow. Clicking the
  // Dispatch button on a regular (non add-to-trip) dispatch group opens this
  // context-bearing modal first; the modal saves the load list, then hands
  // off to the existing DispatchProgressModal via setDispatchDriver. The
  // add-to-trip path still goes straight to dispatch (no load list step —
  // cylinders come from existing float on the truck).
  const [loadListContext, setLoadListContext] = useState<{
    driverId: string;
    driverName: string;
    vehicleNumber: string | null;
    assignmentId: string;
    tripNumber: number;
    orders: Order[];
    orderItems: Array<{ cylinderTypeId: string; quantity: number }>;
  } | null>(null);

  const { data: pendingOrders, isLoading } = useQuery({
    queryKey: ['pending-orders'],
    queryFn: () =>
      apiGet<{ orders: Order[] }>('/orders', {
        status: OrderStatus.PENDING_DRIVER_ASSIGNMENT,
        pageSize: 100,
      }),
  });

  // WI-036: orders already assigned but not yet dispatched, grouped by driver.
  const { data: pendingDispatch } = useQuery({
    queryKey: ['pending-dispatch-orders'],
    queryFn: () =>
      apiGet<{ orders: Order[] }>('/orders', {
        status: OrderStatus.PENDING_DISPATCH,
        pageSize: 100,
      }),
  });

  // WI-065: drivers currently in transit — DVA.status='loaded_and_dispatched'
  // with at least one order still in pending_delivery. Drives the new
  // "In Transit" section. Each row carries the per-driver in-flight /
  // delivered / pending counters so the admin can see the live picture
  // at a glance and use [+ Add to Trip] instead of clicking Dispatch
  // (which would 409 with ALREADY_DISPATCHED).
  type InTransitRow = {
    driverId: string;
    driverName: string | null;
    vehicleId: string | null;
    vehicleNumber: string | null;
    assignmentId: string;
    tripNumber: number;
    tripSheetNo: string | null;
    tripSheetNo2: string | null;
    inTransitCount: number;
    deliveredCount: number;
    pendingCount: number;
  };
  const { data: inTransitData } = useQuery({
    queryKey: ['in-transit-drivers'],
    queryFn: () => apiGet<{ drivers: InTransitRow[] }>('/orders/in-transit'),
    // FLOAT-001 (2026-06-19 Bug #9b): 5s instead of 30s. With 30s, a driver
    // just dispatched would still appear in Ready-to-Dispatch with "Dispatch"
    // button for up to 30 seconds after going on the road, instead of moving
    // to the In Transit panel with "+ Add to Trip". The dispatch-card
    // button conditional on dvaStatus catches the race, but the panel
    // location should still update quickly.
    refetchInterval: 5_000,
  });
  const inTransitDrivers: InTransitRow[] = inTransitData?.drivers ?? [];
  const inTransitDriverIds = new Set(inTransitDrivers.map((d) => d.driverId));

  // Only drivers with a confirmed vehicle mapping for TODAY may be assigned
  // — both for the inline per-row dropdown and the bulk toolbar. This mirrors
  // the backend guard in orderService.assignDriver. Recommendations with
  // status === 'confirmed' have a real DriverVehicleAssignment row for today;
  // 'recommended' (yesterday's mapping copied forward but not confirmed) and
  // 'unassigned' both lack one and would be rejected by the API.
  const today = localTodayISO();
  const { data: vehicleMappings } = useQuery({
    queryKey: ['vehicle-mappings', today],
    queryFn: () =>
      apiGet<{
        recommendations: Array<{
          driverId: string;
          driverName: string;
          vehicleId: string | null;
          vehicleNumber: string | null;
          assignmentId?: string;
          // FLOAT-001 (2026-06-18): exposed by assignmentService for confirmed
          // rows so LoadManifestPanel can key its cache by (assignmentId,
          // tripNumber) — auto-invalidates when the DVA rolls.
          tripNumber?: number;
          // FLOAT-001 (2026-06-19 Bug #9b): DVA status drives the dispatch
          // card's button label — "Dispatch" when dispatch_ready,
          // "+ Add to Trip" when loaded_and_dispatched.
          dvaStatus?: string;
          dvaIsReconciled?: boolean;
          status: string;
          source: string;
        }>;
      }>(`/assignments/vehicle-mappings?date=${today}`),
    staleTime: 60 * 1000,
  });

  const confirmedDrivers = (vehicleMappings?.recommendations ?? []).filter(
    (r) => r.status === 'confirmed',
  );
  const driverOptions = confirmedDrivers.map((d) => ({ value: d.driverId, label: d.driverName }));
  const driverNameById = new Map(confirmedDrivers.map((d) => [d.driverId, d.driverName]));
  const noConfirmedMappings = !!vehicleMappings && confirmedDrivers.length === 0;

  const orders = pendingOrders?.orders ?? [];

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['pending-orders'] });
    queryClient.invalidateQueries({ queryKey: ['pending-dispatch-orders'] });
    queryClient.invalidateQueries({ queryKey: ['in-transit-drivers'] });
    queryClient.invalidateQueries({ queryKey: ['orders'] });
    // FLOAT-001 (2026-06-19 Bug #9b): also refresh vehicle-mappings so the
    // dispatch card's dvaStatus updates immediately after a dispatch /
    // add-to-trip / vehicle return. Without this the card's button stays
    // stale (still says "Dispatch" right after a dispatch) until the next
    // tab focus or page reload.
    queryClient.invalidateQueries({ queryKey: ['vehicle-mappings', today] });
  };

  // WI-036: group pending_dispatch orders by driver for the dispatch UI.
  // Vehicle number comes from the day's vehicle-mappings; if missing the
  // dispatch button is disabled and we surface a warning instead.
  const mappingByDriver = new Map(
    (vehicleMappings?.recommendations ?? []).map((m) => [m.driverId, m]),
  );
  const dispatchGroups: Array<{
    driverId: string;
    driverName: string;
    vehicleNumber: string | null;
    orders: Order[];
    totalValue: number;
  }> = [];
  {
    const byDriver = new Map<string, Order[]>();
    for (const order of pendingDispatch?.orders ?? []) {
      if (!order.driverId) continue;
      // WI-065: drivers with an active trip surface in the new "In
      // Transit" section above with [+ Add to Trip]. Skip them here so
      // the "Ready to Dispatch" section only ever shows drivers whose
      // next click would be a brand-new trip dispatch.
      if (inTransitDriverIds.has(order.driverId)) continue;
      if (!byDriver.has(order.driverId)) byDriver.set(order.driverId, []);
      byDriver.get(order.driverId)!.push(order);
    }
    byDriver.forEach((driverOrders, driverId) => {
      const mapping = mappingByDriver.get(driverId);
      const driverName = mapping?.driverName ?? driverOrders[0]?.driverName ?? 'Driver';
      const vehicleNumber = mapping?.vehicleNumber ?? null;
      const totalValue = driverOrders.reduce(
        (sum, o) => sum + Number(o.totalAmount ?? 0),
        0,
      );
      dispatchGroups.push({ driverId, driverName, vehicleNumber, orders: driverOrders, totalValue });
    });
  }

  const inlineAssign = useMutation({
    mutationFn: ({ orderId, driverId }: { orderId: string; driverId: string }) =>
      apiPost(`/orders/${orderId}/assign-driver`, { driverId }),
    onSuccess: (_data, vars) => {
      const order = orders.find((o: Order) => o.orderId === vars.orderId);
      const driverName = driverNameById.get(vars.driverId) ?? 'driver';
      toast.success(`${order?.orderNumber ?? 'Order'} assigned to ${driverName}`);
      setSelectedOrderIds((prev) => prev.filter((id) => id !== vars.orderId));
      refresh();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const bulkAssign = useMutation({
    mutationFn: ({ orderIds, driverId }: { orderIds: string[]; driverId: string }) =>
      apiPost<Array<{ orderId: string; success: boolean; error?: string }>>(
        '/orders/bulk-assign-driver',
        { orderIds, driverId },
      ),
    onSuccess: (results, vars) => {
      const assigned = Array.isArray(results) ? results.filter((r) => r.success).length : vars.orderIds.length;
      const failed = Array.isArray(results) ? results.length - assigned : 0;
      const driverName = driverNameById.get(vars.driverId) ?? 'driver';
      if (assigned > 0) {
        toast.success(`${assigned} order${assigned === 1 ? '' : 's'} assigned to ${driverName}`);
      }
      if (failed > 0) {
        toast.error(`${failed} order${failed === 1 ? '' : 's'} could not be assigned`);
      }
      setSelectedOrderIds([]);
      setBulkDriverId('');
      refresh();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const allSelected = orders.length > 0 && selectedOrderIds.length === orders.length;
  const toggleSelectAll = () => {
    setSelectedOrderIds(allSelected ? [] : orders.map((o: Order) => o.orderId));
  };
  const toggleSelectOne = (orderId: string) => {
    setSelectedOrderIds((prev) =>
      prev.includes(orderId) ? prev.filter((id) => id !== orderId) : [...prev, orderId],
    );
  };

  const handleBulkAssign = () => {
    if (!bulkDriverId || selectedOrderIds.length === 0) return;
    bulkAssign.mutate({ orderIds: selectedOrderIds, driverId: bulkDriverId });
  };

  const handleAssignAll = () => {
    if (!bulkDriverId || orders.length === 0) return;
    bulkAssign.mutate({ orderIds: orders.map((o: Order) => o.orderId), driverId: bulkDriverId });
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-surface-500 dark:text-surface-400">
          Orders pending driver assignment for this distributor. Use the inline dropdown to assign a single order, or select multiple orders and use the toolbar to bulk-assign.
        </p>
      </div>

      {noConfirmedMappings && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          No drivers have vehicle mappings confirmed for today. Please confirm vehicle mappings in Fleet → Vehicle Mapping first.
        </div>
      )}

      {/* Bulk toolbar */}
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">
          {selectedOrderIds.length > 0
            ? `${selectedOrderIds.length} order${selectedOrderIds.length === 1 ? '' : 's'} selected`
            : 'Select orders to bulk-assign'}
        </span>
        <div className="flex-1 min-w-[200px] max-w-xs">
          <Select
            options={driverOptions}
            placeholder="Select driver"
            value={bulkDriverId}
            onChange={(e) => setBulkDriverId(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          onClick={handleBulkAssign}
          disabled={!bulkDriverId || selectedOrderIds.length === 0 || bulkAssign.isPending}
          loading={bulkAssign.isPending && selectedOrderIds.length > 0}
        >
          Assign Selected
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={handleAssignAll}
          disabled={!bulkDriverId || orders.length === 0 || bulkAssign.isPending}
        >
          Assign All to Driver
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader /></div>
      ) : orders.length === 0 ? (
        <EmptyState
          title="No orders pending driver assignment 🎉"
          description="All orders for this distributor have been assigned."
        />
      ) : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th className="w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="rounded border-surface-300 dark:border-surface-600"
                  />
                </th>
                <th>Order #</th>
                <th>Customer</th>
                <th>Delivery Date</th>
                <th>Total</th>
                <th>Assign Driver</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order: Order) => (
                <tr key={order.orderId}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedOrderIds.includes(order.orderId)}
                      onChange={() => toggleSelectOne(order.orderId)}
                      className="rounded border-surface-300 dark:border-surface-600"
                    />
                  </td>
                  <td className="font-medium font-mono text-surface-900 dark:text-white">{order.orderNumber}</td>
                  <td>{order.customerName}</td>
                  <td>{order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString('en-IN') : '—'}</td>
                  <td className="font-medium">{formatCurrency(order.totalAmount ?? 0)}</td>
                  <td className="min-w-[200px]">
                    <Select
                      options={driverOptions}
                      placeholder="Assign Driver"
                      value=""
                      onChange={(e) => {
                        const driverId = e.target.value;
                        if (driverId) inlineAssign.mutate({ orderId: order.orderId, driverId });
                      }}
                      disabled={inlineAssign.isPending}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* WI-065: In-Transit section — drivers with an active trip
          (DVA.status='loaded_and_dispatched'). Sits ABOVE "Ready to
          Dispatch" so the admin always sees the live picture before
          deciding whether to start a new trip or extend the current one.
          Each row's [+ Add to Trip] button is gated on pendingCount>0
          (new orders assigned to this driver since dispatch). */}
      {inTransitDrivers.length > 0 && (
        <div className="space-y-3">
          <div>
            <h3 className="text-lg font-semibold text-surface-900 dark:text-white">
              In Transit
            </h3>
            <p className="text-sm text-surface-500 dark:text-surface-400">
              Drivers currently on a route. Use “+ Add to Trip” to dispatch newly assigned orders on the existing trip.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3">
            {inTransitDrivers.map((d) => {
              const tripSheetParts = [d.tripSheetNo, d.tripSheetNo2].filter(Boolean);
              const tripSheetLine = tripSheetParts.length > 0
                ? `Consolidated EWB: ${tripSheetParts.join(' + ')}`
                : 'No consolidated EWB yet';
              return (
                <div key={d.driverId} className="card p-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-surface-900 dark:text-white">
                      {d.driverName ?? 'Driver'}
                      <span className="ml-2 text-sm text-surface-500 dark:text-surface-400">
                        {d.vehicleNumber ?? '(no vehicle)'}
                      </span>
                      <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        Trip {d.tripNumber}
                      </span>
                    </div>
                    <div className="text-sm text-surface-500 dark:text-surface-400">
                      {d.inTransitCount} in transit · {d.deliveredCount} delivered
                      {d.pendingCount > 0 && (
                        <>
                          {' · '}
                          <span className="text-brand-600 dark:text-brand-400 font-medium">
                            {d.pendingCount} pending
                          </span>
                        </>
                      )}
                    </div>
                    <div className="text-xs text-surface-400 mt-1">{tripSheetLine}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        try {
                          const resp = await api.get(`/orders/trip-sheet/${d.assignmentId}`, {
                            responseType: 'blob',
                          });
                          const url = window.URL.createObjectURL(resp.data);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `trip-sheet-${(d.driverName ?? 'driver').replace(/\s+/g, '-')}.pdf`;
                          a.click();
                          window.URL.revokeObjectURL(url);
                        } catch (err) {
                          toast.error(getErrorMessage(err));
                        }
                      }}
                    >
                      📄 Trip Sheet
                    </Button>
                    {/* WI-068: hide (rather than disable) the Add to
                        Trip button when there are no new orders. The
                        disabled state used to render even when
                        pendingCount=0, inviting a click that the
                        server-side gate would 409 anyway. Also surface
                        the count in the label so the admin knows
                        exactly how many orders the click will dispatch. */}
                    {d.pendingCount > 0 && (
                      <Button
                        size="sm"
                        onClick={() => setDispatchDriver({
                          driverId: d.driverId,
                          driverName: d.driverName ?? 'Driver',
                          vehicleNumber: d.vehicleNumber,
                          assignmentId: d.assignmentId,
                          orders: (pendingDispatch?.orders ?? []).filter((o: Order) => o.driverId === d.driverId),
                          mode: 'add_to_trip',
                        })}
                      >
                        + Add {d.pendingCount} to Trip
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* WI-036: Ready-to-dispatch section — one card per driver with pending_dispatch orders. */}
      {dispatchGroups.length > 0 && (
        <div className="space-y-3">
          <div>
            <h3 className="text-lg font-semibold text-surface-900 dark:text-white">
              Ready to Dispatch
            </h3>
            <p className="text-sm text-surface-500 dark:text-surface-400">
              Click Dispatch to generate IRN + EWB for each driver&apos;s orders before the vehicle leaves the depot.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3">
            {dispatchGroups.map((g) => {
              const canDispatch = !!g.vehicleNumber;
              const mapping = mappingByDriver.get(g.driverId);
              return (
                <div
                  key={g.driverId}
                  className="card p-4 flex flex-col gap-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-surface-900 dark:text-white">
                        {g.driverName}
                        <span className="ml-2 text-sm text-surface-500 dark:text-surface-400">
                          {g.vehicleNumber ?? '(no vehicle)'}
                        </span>
                      </div>
                      <div className="text-sm text-surface-500 dark:text-surface-400">
                        {g.orders.length} order{g.orders.length === 1 ? '' : 's'}
                        {' · '}
                        {formatCurrency(g.totalValue)}
                      </div>
                      {!canDispatch && (
                        <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                          ⚠ Assign vehicle in Fleet → Vehicle Mapping first
                        </div>
                      )}
                    </div>
                    {/* FLOAT-001 (2026-06-19 Bug #9b): switch button when the
                        driver's vehicle is ALREADY on the road (DVA at
                        loaded_and_dispatched). Add-to-Trip dispatches new
                        orders onto the existing trip via preflightAddToTrip
                        (NO new depot debit — cylinders come from float).
                        Without this the admin would click Dispatch and start
                        a brand-new trip with phantom dispatch events. */}
                    {mapping?.dvaStatus === 'loaded_and_dispatched' ? (
                      <Button
                        size="sm"
                        disabled={!canDispatch}
                        onClick={() =>
                          setDispatchDriver({
                            driverId: g.driverId,
                            driverName: g.driverName,
                            vehicleNumber: g.vehicleNumber,
                            assignmentId: mapping?.assignmentId ?? null,
                            orders: g.orders,
                            mode: 'add_to_trip',
                          })
                        }
                      >
                        + Add {g.orders.length} to Trip
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={!canDispatch}
                        onClick={() => {
                          const orderItems = g.orders.flatMap((o) =>
                            (o.items ?? []).map((it) => ({
                              cylinderTypeId: it.cylinderTypeId,
                              quantity: it.quantity,
                            })),
                          );
                          // FLOAT-001 (Round 2): when we have a DVA, open the
                          // Load List modal first so the admin can confirm
                          // booked + spare before NIC is hit. If the day's
                          // vehicle mapping hasn't surfaced an assignmentId
                          // yet, fall through to the legacy direct-dispatch
                          // path (preflight uses driverId + date, not DVA id).
                          if (mapping?.assignmentId) {
                            setLoadListContext({
                              driverId: g.driverId,
                              driverName: g.driverName,
                              vehicleNumber: g.vehicleNumber,
                              assignmentId: mapping.assignmentId,
                              tripNumber: mapping.tripNumber ?? 1,
                              orders: g.orders,
                              orderItems,
                            });
                          } else {
                            setDispatchDriver({
                              driverId: g.driverId,
                              driverName: g.driverName,
                              vehicleNumber: g.vehicleNumber,
                              assignmentId: null,
                              orders: g.orders,
                            });
                          }
                        }}
                      >
                        Dispatch {g.driverName.split(' ')[0]} ▶
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loadListContext && (
        <LoadListDispatchModal
          open
          driverName={loadListContext.driverName}
          vehicleNumber={loadListContext.vehicleNumber}
          assignmentId={loadListContext.assignmentId}
          tripNumber={loadListContext.tripNumber}
          orderItems={loadListContext.orderItems}
          onClose={() => setLoadListContext(null)}
          onDispatchNow={() => {
            // Hand off to the existing DispatchProgressModal — it owns the
            // preflight call + per-order result UI. We only close ourselves.
            const ctx = loadListContext;
            setLoadListContext(null);
            setDispatchDriver({
              driverId: ctx.driverId,
              driverName: ctx.driverName,
              vehicleNumber: ctx.vehicleNumber,
              assignmentId: ctx.assignmentId,
              orders: ctx.orders,
            });
          }}
        />
      )}

      {dispatchDriver && (
        <DispatchProgressModal
          driver={dispatchDriver}
          onClose={() => {
            setDispatchDriver(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}


// ─── Dispatch Progress Modal ────────────────────────────────────────────────
// WI-036: Calls POST /api/orders/preflight-dispatch, shows per-order
// success/failure rows, and on full success offers a trip-sheet download
// (WI-038). Renders a "Dispatching…" pulse while in flight.

type DispatchDriverContext = {
  driverId: string;
  driverName: string;
  vehicleNumber: string | null;
  assignmentId: string | null;
  orders: Order[];
  // WI-065: 'add_to_trip' → POST /preflight-add-to-trip (keep trip
  // number, dispatch only new orders). Anything else / undefined →
  // POST /preflight-dispatch (start a new trip).
  mode?: 'new_trip' | 'add_to_trip';
};

type PreflightResultRow = {
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  mode: string;
  success: boolean;
  irn?: string | null;
  ewbNo?: string | null;
  errorCode?: string;
  errorMessage?: string;
};

type PreflightResponseEnvelope = {
  summary: { total: number; succeeded: number; failed: number };
  results: PreflightResultRow[];
  dispatched: boolean;
};

function DispatchProgressModal({
  driver,
  onClose,
}: {
  driver: DispatchDriverContext;
  onClose: () => void;
}) {
  const today = localTodayISO();
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [result, setResult] = useState<PreflightResponseEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  // WI-065: route to the right preflight endpoint based on mode. Both
  // endpoints share the same response shape, so the rest of the modal
  // body is unchanged.
  const endpoint = driver.mode === 'add_to_trip'
    ? '/orders/preflight-add-to-trip'
    : '/orders/preflight-dispatch';

  const run = async () => {
    setPhase('running');
    setError(null);
    try {
      const resp = await apiPost<PreflightResponseEnvelope>(endpoint, {
        driverId: driver.driverId,
        assignmentDate: today,
      });
      setResult(resp);
      setPhase('done');
    } catch (err) {
      setError(getErrorMessage(err));
      setPhase('done');
    }
  };

  // Auto-start preflight when the modal opens. StrictMode double-invokes
  // effects in dev, so guard with a ref to fire the API call exactly once.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Trip sheet download goes through the shared axios client so the
  // Authorization + X-Distributor-Id headers are injected — a raw <a href>
  // would download a 401 JSON body as the PDF (see Anti-pattern #5).
  const downloadTripSheet = async () => {
    if (!driver.assignmentId) return;
    try {
      const resp = await api.get(`/orders/trip-sheet/${driver.assignmentId}`, {
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trip-sheet-${driver.driverName.replace(/\s+/g, '-')}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${driver.mode === 'add_to_trip' ? 'Adding to' : 'Dispatching'} ${driver.driverName}'s orders`}
      size="md"
    >
      <div className="space-y-4">
        <div className="text-sm text-surface-500 dark:text-surface-400">
          {driver.vehicleNumber ?? '(no vehicle)'} · {driver.orders.length} order
          {driver.orders.length === 1 ? '' : 's'}
        </div>

        {phase === 'running' && (
          <div className="flex items-center gap-3 py-4">
            <Loader size="sm" />
            <span className="text-sm">Generating IRN / EWB at WhiteBooks…</span>
          </div>
        )}

        {phase === 'done' && error && (
          <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
            {error}
          </div>
        )}

        {phase === 'done' && result && (
          <>
            <div className="text-sm font-medium">
              {result.summary.succeeded}/{result.summary.total} dispatched
              {result.summary.failed > 0
                ? ` · ${result.summary.failed} need attention`
                : ' successfully'}
            </div>
            <ul className="divide-y divide-surface-200 dark:divide-surface-700 rounded-lg border border-surface-200 dark:border-surface-700">
              {result.results.map((r) => (
                <li key={r.orderId} className="px-3 py-2 flex items-start gap-2 text-sm">
                  <span
                    className={cn(
                      'mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-xs',
                      r.success
                        ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300'
                        : 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300',
                    )}
                  >
                    {r.success ? '✓' : '✗'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono font-medium">
                      {r.orderNumber}
                      {r.customerName && (
                        <span className="ml-2 text-surface-500 dark:text-surface-400 font-sans font-normal">
                          — {r.customerName}
                        </span>
                      )}
                    </div>
                    {r.success ? (
                      <div className="text-xs text-surface-500 dark:text-surface-400">
                        {r.mode}
                        {r.irn ? ` · IRN ${r.irn.slice(0, 12)}…` : ''}
                        {r.ewbNo ? ` · EWB ${r.ewbNo}` : ''}
                      </div>
                    ) : (
                      <div className="text-xs text-red-700 dark:text-red-300">
                        {r.errorCode ? `${r.errorCode}: ` : ''}
                        {r.errorMessage ?? 'Failed'}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="flex justify-end gap-2 pt-2">
          {/*
            Download Trip Sheet is only useful when there's an EWB on the
            route — either inline EWB on the IRN (B2B success) or a
            standalone EWB (B2C success). If every order failed or only
            GST-disabled / no-EWB results came back, the trip-sheet
            endpoint will return 400 anyway, so hide the button.
            WI-064: also require `result.dispatched` (envelope-level
            "every order succeeded"). If the admin re-opens the modal
            after the driver has already delivered every order,
            `dispatched` is false and we must NOT show a button that
            will hit a 400 from tripSheetPdfService — that service
            requires at least one in-transit (pending_delivery) order.
          */}
          {phase === 'done' && result && driver.assignmentId &&
            result.dispatched && result.results.some((r) => !!r.ewbNo) && (
            <Button variant="secondary" onClick={downloadTripSheet}>
              Download Trip Sheet
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={phase === 'running'}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

