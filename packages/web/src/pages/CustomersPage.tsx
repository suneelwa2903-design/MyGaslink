import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlinePencilSquare,
  HiOutlineMagnifyingGlass,
  HiOutlineEye,
  HiOutlineNoSymbol,
  HiOutlinePlayCircle,
  HiOutlineTrash,
} from 'react-icons/hi2';
import {
  type Customer,
  type CylinderType,
  type PaginationMeta,
  type Order,
  type Invoice,
  type Payment,
  type CustomerInventoryBalance,
  type LedgerEntry,
  CustomerStatus,
  createCustomerSchema,
  type CreateCustomerInput,
  UserRole,
} from '@gaslink/shared';
import { apiGet, apiPost, apiPut, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';
import { useAuthStore, selectRole } from '@/stores/authStore';
import { cn } from '@/lib/cn';

const STATUS_MAP: Record<string, { variant: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  [CustomerStatus.ACTIVE]: { variant: 'success', label: 'Active' },
  [CustomerStatus.SUSPENDED]: { variant: 'warning', label: 'Suspended' },
  [CustomerStatus.INACTIVE]: { variant: 'danger', label: 'Inactive' },
};

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
}

export default function CustomersPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null);
  const [viewCustomer, setViewCustomer] = useState<Customer | null>(null);

  const queryParams: Record<string, unknown> = { page, pageSize: 25 };
  if (search) queryParams.search = search;
  if (statusFilter) queryParams.status = statusFilter;

  const { data, isLoading } = useQuery({
    queryKey: ['customers', queryParams],
    queryFn: () => apiGet<{ customers: Customer[]; meta: PaginationMeta }>('/customers', queryParams),
  });

  const { data: cylinderTypes } = useQuery({
    queryKey: ['cylinder-types'],
    queryFn: () => apiGet<{ cylinderTypes: CylinderType[] }>('/cylinder-types'),
    select: (data) => data.cylinderTypes,
    staleTime: 10 * 60 * 1000,
  });

  const stopSupplyMutation = useMutation({
    mutationFn: (customerId: string) => apiPost(`/customers/${customerId}/stop-supply`),
    onSuccess: () => {
      toast.success('Supply stopped');
      queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const resumeSupplyMutation = useMutation({
    mutationFn: (customerId: string) => apiPost(`/customers/${customerId}/resume-supply`),
    onSuccess: () => {
      toast.success('Supply resumed');
      queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const customers = data?.customers ?? [];
  const meta = data?.meta;

  // Finance has view-only customer access (backend allows GET but not
  // create/edit/supply). Hide mutation controls so finance doesn't get
  // buttons that 403 on submit. super_admin / distributor_admin /
  // inventory can manage.
  const role = useAuthStore(selectRole);
  const canManage = role !== UserRole.FINANCE;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Customers</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Manage your customer base</p>
        </div>
        {canManage && (
          <Button onClick={() => setCreateOpen(true)}>
            <HiOutlinePlus className="h-4 w-4" />
            New Customer
          </Button>
        )}
      </div>

      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="relative sm:col-span-2">
            <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-400" />
            <input
              type="text"
              placeholder="Search customers..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="input pl-9 py-2"
            />
          </div>
          <Select
            options={Object.values(CustomerStatus).map((s) => ({ value: s, label: STATUS_MAP[s]?.label || s }))}
            placeholder="All Statuses"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : customers.length === 0 ? (
        <EmptyState
          title="No customers found"
          description="Add your first customer to get started."
          action={canManage ? <Button onClick={() => setCreateOpen(true)}><HiOutlinePlus className="h-4 w-4" />Add Customer</Button> : undefined}
        />
      ) : (
        <>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Type</th>
                  <th>Credit Period</th>
                  <th>Supply</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.customerId}>
                    <td>
                      <div>
                        <p className="font-medium text-surface-900 dark:text-white">{customer.customerName}</p>
                        {customer.businessName && (
                          <p className="text-xs text-surface-400">{customer.businessName}</p>
                        )}
                      </div>
                    </td>
                    <td>{customer.phone}</td>
                    <td><Badge variant="neutral">{customer.customerType}</Badge></td>
                    <td>{customer.creditPeriodDays} days</td>
                    <td>
                      {customer.stopSupply ? (
                        <Badge variant="danger">Stopped</Badge>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                    </td>
                    <td>
                      <Badge variant={STATUS_MAP[customer.status]?.variant || 'neutral'}>
                        {STATUS_MAP[customer.status]?.label || customer.status}
                      </Badge>
                    </td>
                    <td>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setViewCustomer(customer)}
                          className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500"
                          title="View"
                        >
                          <HiOutlineEye className="h-4 w-4" />
                        </button>
                        {canManage && (
                          <button
                            onClick={() => setEditCustomer(customer)}
                            className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-500"
                            title="Edit"
                          >
                            <HiOutlinePencilSquare className="h-4 w-4" />
                          </button>
                        )}
                        {canManage && (customer.stopSupply ? (
                          <button
                            onClick={() => resumeSupplyMutation.mutate(customer.customerId)}
                            className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-accent-500"
                            title="Resume Supply"
                          >
                            <HiOutlinePlayCircle className="h-4 w-4" />
                          </button>
                        ) : (
                          <button
                            onClick={() => stopSupplyMutation.mutate(customer.customerId)}
                            className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-red-500"
                            title="Stop Supply"
                          >
                            <HiOutlineNoSymbol className="h-4 w-4" />
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {meta && meta.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-surface-500 dark:text-surface-400">
                Showing {(meta.page - 1) * meta.pageSize + 1}-{Math.min(meta.page * meta.pageSize, meta.total)} of {meta.total}
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button variant="secondary" size="sm" disabled={page >= meta.totalPages} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Create Modal */}
      {createOpen && (
        <CustomerFormModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          cylinderTypes={cylinderTypes ?? []}
        />
      )}

      {/* Edit Modal */}
      {editCustomer && (
        <CustomerFormModal
          open={!!editCustomer}
          onClose={() => setEditCustomer(null)}
          customer={editCustomer}
          cylinderTypes={cylinderTypes ?? []}
        />
      )}

      {/* View Detail Modal */}
      {viewCustomer && (
        <CustomerDetailModal
          open={!!viewCustomer}
          onClose={() => setViewCustomer(null)}
          customer={viewCustomer}
        />
      )}
    </div>
  );
}

// ─── Customer Form Modal ──────────────────────────────────────────────────────

function CustomerFormModal({
  open,
  onClose,
  customer,
  cylinderTypes,
}: {
  open: boolean;
  onClose: () => void;
  customer?: Customer;
  cylinderTypes: CylinderType[];
}) {
  const queryClient = useQueryClient();
  const isEdit = !!customer;

  const { register, handleSubmit, control, getValues, setValue, watch, formState: { errors } } = useForm<CreateCustomerInput>({
    resolver: zodResolver(createCustomerSchema) as any,
    defaultValues: customer
      ? {
          customerName: customer.customerName,
          businessName: customer.businessName || '',
          gstin: customer.gstin || '',
          phone: customer.phone,
          email: customer.email || '',
          billingAddressLine1: customer.billingAddressLine1 || '',
          billingAddressLine2: customer.billingAddressLine2 || '',
          billingCity: customer.billingCity || '',
          billingState: customer.billingState || '',
          billingPincode: customer.billingPincode || '',
          shippingAddressLine1: customer.shippingAddressLine1 || '',
          shippingAddressLine2: customer.shippingAddressLine2 || '',
          shippingCity: customer.shippingCity || '',
          shippingState: customer.shippingState || '',
          shippingPincode: customer.shippingPincode || '',
          creditPeriodDays: customer.creditPeriodDays,
          contacts: customer.contacts.map((c) => ({ name: c.name, phone: c.phone, email: c.email || '', isPrimary: c.isPrimary })),
          cylinderDiscounts: customer.cylinderDiscounts.map((d) => ({ cylinderTypeId: d.cylinderTypeId, discountPerUnit: d.discountPerUnit })),
        }
      : {
          customerName: '',
          phone: '',
          creditPeriodDays: 30,
          contacts: [],
          cylinderDiscounts: [],
        },
  });

  const contactFields = useFieldArray({ control, name: 'contacts' });
  const discountFields = useFieldArray({ control, name: 'cylinderDiscounts' });

  // ─── WI-040: GSTIN autofill ─────────────────────────────────────────────
  // Click "Fetch Details" → call /distributors/gstin-lookup/:gstin → fill
  // business name + billing address fields. Phone is preserved (NIC data
  // is often stale for contact info). The returned status surfaces as a
  // small Active/Inactive pill so admins know if the GSTIN is suspended.
  type GstinLookupResponse = {
    gstin: string;
    legalName: string;
    tradeName: string;
    address: string;
    city: string;
    state: string;
    stateCode: string;
    pincode: string;
    status: string;
  };
  const [gstinLookupStatus, setGstinLookupStatus] = useState<string | null>(null);
  const [gstinLookupError, setGstinLookupError] = useState<string | null>(null);
  const gstinValue = watch('gstin');

  const gstinLookupMutation = useMutation({
    mutationFn: (gstin: string) =>
      apiGet<GstinLookupResponse>(`/distributors/gstin-lookup/${encodeURIComponent(gstin)}`),
    onSuccess: (data) => {
      setGstinLookupStatus(data.status || 'Active');
      setGstinLookupError(null);
      // Preserve existing customerName + phone; everything else gets the
      // NIC data. shouldDirty=true so react-hook-form treats it as edited.
      const opts = { shouldDirty: true, shouldTouch: true };
      setValue('businessName', data.tradeName || data.legalName || '', opts);
      // The lookup service returns a joined address string. Put the whole
      // thing in line 1; admins can manually split if needed.
      setValue('billingAddressLine1', data.address || '', opts);
      setValue('billingAddressLine2', '', opts);
      setValue('billingCity', data.city || '', opts);
      setValue('billingState', data.state || '', opts);
      setValue('billingPincode', data.pincode || '', opts);
      toast.success('GSTIN details fetched');
    },
    onError: (err) => {
      setGstinLookupStatus(null);
      setGstinLookupError(getErrorMessage(err));
    },
  });

  const handleFetchGstin = () => {
    setGstinLookupError(null);
    const raw = (getValues('gstin') || '').trim().toUpperCase();
    if (raw.length !== 15) {
      setGstinLookupError('GSTIN must be exactly 15 characters');
      return;
    }
    gstinLookupMutation.mutate(raw);
  };

  // Status indicator colour mapping. The NIC `status` field returns
  // free-form strings — group them into active vs everything-else.
  const isActiveGstin = !!gstinLookupStatus &&
    /^active$/i.test(gstinLookupStatus);

  const mutation = useMutation({
    mutationFn: (data: CreateCustomerInput) =>
      isEdit
        ? apiPut(`/customers/${customer.customerId}`, data)
        : apiPost('/customers', data),
    onSuccess: () => {
      toast.success(isEdit ? 'Customer updated' : 'Customer created');
      // ['customers'] = the Customers page table.
      // ['customers-list'] = the customer dropdown the Record Payment form
      //   uses (BillingPaymentsPage) — without this, a renamed customer
      //   shows the stale name in the payment dropdown.
      // ['payments'] = payment rows embed the customer name.
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['customers-list'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: ct.typeName }));

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Customer' : 'New Customer'} size="xl">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data as CreateCustomerInput))} className="space-y-6">
        {/* Basic Info */}
        <div>
          <h3 className="text-sm font-semibold text-surface-900 dark:text-white mb-3">Basic Information</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Customer Name" required error={errors.customerName?.message} {...register('customerName')} />
            <Input label="Business Name" {...register('businessName')} />
            <Input label="Phone" required error={errors.phone?.message} {...register('phone')} />
            <Input label="Email" type="email" {...register('email')} />
            <div>
              {/* WI-040: GSTIN field with "Fetch Details" button to autofill
                  business name and billing address from the NIC portal. */}
              <Input
                label="GSTIN"
                placeholder="e.g. 29ABCDE1234F1Z5"
                {...register('gstin')}
              />
              <div className="mt-1 flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={handleFetchGstin}
                  loading={gstinLookupMutation.isPending}
                  disabled={!gstinValue || gstinValue.trim().length !== 15}
                >
                  Fetch Details
                </Button>
                {gstinLookupStatus && (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 text-xs',
                      isActiveGstin
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-600 dark:text-red-400',
                    )}
                  >
                    <span className="inline-block h-2 w-2 rounded-full bg-current" />
                    {gstinLookupStatus}
                  </span>
                )}
                {gstinLookupError && (
                  <span className="text-xs text-red-600 dark:text-red-400">
                    {gstinLookupError}
                  </span>
                )}
              </div>
            </div>
            <Input label="Credit Period (days)" type="number" {...register('creditPeriodDays', { valueAsNumber: true })} />
          </div>
        </div>

        {/* Billing Address */}
        <div>
          <h3 className="text-sm font-semibold text-surface-900 dark:text-white mb-3">Billing Address</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Address Line 1" {...register('billingAddressLine1')} />
            <Input label="Address Line 2" {...register('billingAddressLine2')} />
            <Input label="City" {...register('billingCity')} />
            <Input label="State" {...register('billingState')} />
            <Input label="Pincode" {...register('billingPincode')} />
          </div>
        </div>

        {/* Shipping Address */}
        <div>
          <h3 className="text-sm font-semibold text-surface-900 dark:text-white mb-3">Shipping Address</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Address Line 1" {...register('shippingAddressLine1')} />
            <Input label="Address Line 2" {...register('shippingAddressLine2')} />
            <Input label="City" {...register('shippingCity')} />
            <Input label="State" {...register('shippingState')} />
            <Input label="Pincode" {...register('shippingPincode')} />
          </div>
        </div>

        {/* Contacts */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-white">Contacts</h3>
            <Button type="button" variant="ghost" size="sm" onClick={() => contactFields.append({ name: '', phone: '', email: '', isPrimary: false })}>
              <HiOutlinePlus className="h-3 w-3" />Add Contact
            </Button>
          </div>
          {contactFields.fields.map((field, index) => (
            <div key={field.id} className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-3 p-3 bg-surface-50 dark:bg-surface-800/50 rounded-xl">
              <Input placeholder="Name" required error={errors.contacts?.[index]?.name?.message} {...register(`contacts.${index}.name`)} />
              <Input placeholder="Phone" required error={errors.contacts?.[index]?.phone?.message} {...register(`contacts.${index}.phone`)} />
              <Input placeholder="Email" {...register(`contacts.${index}.email`)} />
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-xs text-surface-500">
                  <input type="checkbox" {...register(`contacts.${index}.isPrimary`)} className="rounded" />
                  Primary
                </label>
                <button type="button" onClick={() => contactFields.remove(index)} className="p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded">
                  <HiOutlineTrash className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Cylinder Discounts */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-white">Cylinder Discounts</h3>
            <Button type="button" variant="ghost" size="sm" onClick={() => discountFields.append({ cylinderTypeId: '', discountPerUnit: 0 })}>
              <HiOutlinePlus className="h-3 w-3" />Add Discount
            </Button>
          </div>
          {discountFields.fields.map((field, index) => (
            <div key={field.id} className="flex items-start gap-3 mb-3">
              <div className="flex-1">
                <Select options={cylinderOptions} placeholder="Cylinder Type" required error={errors.cylinderDiscounts?.[index]?.cylinderTypeId?.message} {...register(`cylinderDiscounts.${index}.cylinderTypeId`)} />
              </div>
              <div className="w-32">
                <Input type="number" placeholder="Discount/unit" step="0.01" required error={errors.cylinderDiscounts?.[index]?.discountPerUnit?.message} {...register(`cylinderDiscounts.${index}.discountPerUnit`, { valueAsNumber: true })} />
              </div>
              <button type="button" onClick={() => discountFields.remove(index)} className="mt-1 p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg">
                <HiOutlineTrash className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>{isEdit ? 'Update' : 'Create'} Customer</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Customer Detail Modal ────────────────────────────────────────────────────

function CustomerDetailModal({
  open,
  onClose,
  customer,
}: {
  open: boolean;
  onClose: () => void;
  customer: Customer;
}) {
  const [tab, setTab] = useState<'orders' | 'invoices' | 'payments' | 'inventory' | 'ledger'>('orders');

  const { data: orders, isLoading: ordersLoading } = useQuery({
    queryKey: ['customer-orders', customer.customerId],
    queryFn: () => apiGet<{ orders: Order[] }>('/orders', { customerId: customer.customerId, pageSize: 20 }),
    enabled: tab === 'orders',
  });

  const { data: invoices, isLoading: invoicesLoading } = useQuery({
    queryKey: ['customer-invoices', customer.customerId],
    queryFn: () => apiGet<{ invoices: Invoice[] }>('/invoices', { customerId: customer.customerId, pageSize: 20 }),
    enabled: tab === 'invoices',
  });

  const { data: payments, isLoading: paymentsLoading } = useQuery({
    queryKey: ['customer-payments', customer.customerId],
    queryFn: () => apiGet<{ payments: Payment[] }>('/payments', { customerId: customer.customerId, pageSize: 20 }),
    enabled: tab === 'payments',
  });

  const { data: balances, isLoading: balancesLoading } = useQuery({
    queryKey: ['customer-balances', customer.customerId],
    queryFn: () => apiGet<CustomerInventoryBalance[]>(`/inventory/customer-balances/${customer.customerId}`),
    enabled: tab === 'inventory',
  });

  const { data: ledgerEntries, isLoading: ledgerLoading } = useQuery({
    queryKey: ['customer-ledger', customer.customerId],
    queryFn: () => apiGet<LedgerEntry[]>(`/payments/ledger/${customer.customerId}`),
    enabled: tab === 'ledger',
  });

  const tabs = [
    { key: 'orders' as const, label: 'Orders' },
    { key: 'invoices' as const, label: 'Invoices' },
    { key: 'payments' as const, label: 'Payments' },
    { key: 'inventory' as const, label: 'Inventory Balances' },
    { key: 'ledger' as const, label: 'Ledger' },
  ];

  return (
    <Modal open={open} onClose={onClose} title={customer.customerName} size="xl">
      {/* Customer Info Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <div>
          <p className="text-xs text-surface-500 dark:text-surface-400">Phone</p>
          <p className="text-sm font-medium text-surface-900 dark:text-white">{customer.phone}</p>
        </div>
        <div>
          <p className="text-xs text-surface-500 dark:text-surface-400">Type</p>
          <p className="text-sm font-medium text-surface-900 dark:text-white">{customer.customerType}</p>
        </div>
        <div>
          <p className="text-xs text-surface-500 dark:text-surface-400">Credit Period</p>
          <p className="text-sm font-medium text-surface-900 dark:text-white">{customer.creditPeriodDays} days</p>
        </div>
        <div>
          <p className="text-xs text-surface-500 dark:text-surface-400">GSTIN</p>
          <p className="text-sm font-medium text-surface-900 dark:text-white">{customer.gstin || 'N/A'}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-surface-200 dark:border-surface-700 mb-4">
        <div className="flex gap-4">
          {tabs.map((t) => (
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

      {/* Tab Content */}
      <div className="min-h-[200px]">
        {tab === 'orders' && (
          ordersLoading ? <div className="flex justify-center py-8"><Loader /></div> :
          !orders?.orders?.length ? <EmptyState title="No orders" /> :
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Order #</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {orders.orders.map((o) => (
                  <tr key={o.orderId}>
                    <td className="font-medium">{o.orderNumber}</td>
                    <td>{new Date(o.orderDate).toLocaleDateString('en-IN')}</td>
                    <td>{formatCurrency(o.totalAmount)}</td>
                    <td><Badge variant={o.status === 'delivered' ? 'success' : 'info'}>{o.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'invoices' && (
          invoicesLoading ? <div className="flex justify-center py-8"><Loader /></div> :
          !invoices?.invoices?.length ? <EmptyState title="No invoices" /> :
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Invoice #</th><th>Date</th><th>Total</th><th>Outstanding</th><th>Status</th></tr></thead>
              <tbody>
                {invoices.invoices.map((inv) => (
                  <tr key={inv.invoiceId}>
                    <td className="font-medium">{inv.invoiceNumber}</td>
                    <td>{new Date(inv.issueDate).toLocaleDateString('en-IN')}</td>
                    <td>{formatCurrency(inv.totalAmount)}</td>
                    <td>{formatCurrency(inv.outstandingAmount)}</td>
                    <td><Badge variant={inv.status === 'paid' ? 'success' : inv.status === 'overdue' ? 'danger' : 'info'}>{inv.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'payments' && (
          paymentsLoading ? <div className="flex justify-center py-8"><Loader /></div> :
          !payments?.payments?.length ? <EmptyState title="No payments" /> :
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead>
              <tbody>
                {payments.payments.map((p) => (
                  <tr key={p.paymentId}>
                    <td>{new Date(p.transactionDate).toLocaleDateString('en-IN')}</td>
                    <td className="font-medium">{formatCurrency(p.amount)}</td>
                    <td><Badge variant="neutral">{p.paymentMethod}</Badge></td>
                    <td><Badge variant={p.allocationStatus === 'fully_allocated' ? 'success' : 'warning'}>{p.allocationStatus}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'inventory' && (
          balancesLoading ? <div className="flex justify-center py-8"><Loader /></div> :
          !balances?.length ? <EmptyState title="No inventory balances" /> :
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Cylinder Type</th><th>With Customer</th><th>Pending Returns</th><th>Missing</th></tr></thead>
              <tbody>
                {balances.map((b) => (
                  <tr key={b.cylinderTypeId}>
                    <td className="font-medium">{b.cylinderTypeName}</td>
                    <td>{b.withCustomerQty}</td>
                    <td>{b.pendingReturns}</td>
                    <td>{b.missingQty > 0 ? <span className="text-red-500 font-medium">{b.missingQty}</span> : 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'ledger' && (
          <LedgerTab entries={ledgerEntries ?? []} loading={ledgerLoading} />
        )}
      </div>
    </Modal>
  );
}

// ─── Ledger Tab ──────────────────────────────────────────────────────────────

const LEDGER_TYPE_BADGE: Record<string, { variant: 'info' | 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  invoice_entry: { variant: 'info', label: 'Invoice' },
  invoice: { variant: 'info', label: 'Invoice' },
  payment_entry: { variant: 'success', label: 'Payment' },
  payment: { variant: 'success', label: 'Payment' },
  credit_note: { variant: 'warning', label: 'Credit Note' },
  debit_note: { variant: 'danger', label: 'Debit Note' },
  adjustment: { variant: 'neutral', label: 'Adjustment' },
};

function LedgerTab({ entries, loading }: { entries: LedgerEntry[]; loading: boolean }) {
  if (loading) return <div className="flex justify-center py-8"><Loader /></div>;
  if (!entries.length) return <EmptyState title="No ledger entries" />;

  // Sort chronologically (oldest first) for running balance calculation
  const sorted = [...entries].sort(
    (a, b) => new Date(a.entryDate).getTime() - new Date(b.entryDate).getTime()
  );

  let runningBalance = 0;
  const rows = sorted.map((entry) => {
    runningBalance += entry.amountDelta;
    const debit = entry.amountDelta > 0 ? entry.amountDelta : null;
    const credit = entry.amountDelta < 0 ? Math.abs(entry.amountDelta) : null;
    return { ...entry, debit, credit, balance: runningBalance };
  });

  const totalDebits = rows.reduce((sum, r) => sum + (r.debit ?? 0), 0);
  const totalCredits = rows.reduce((sum, r) => sum + (r.credit ?? 0), 0);
  const finalBalance = runningBalance;

  return (
    <div className="space-y-4">
      <div className="table-container">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Narration</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
              <th className="text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const badge = LEDGER_TYPE_BADGE[row.entryType] ?? { variant: 'neutral' as const, label: row.entryType };
              return (
                <tr key={row.id}>
                  <td className="whitespace-nowrap">{new Date(row.entryDate).toLocaleDateString('en-IN')}</td>
                  <td><Badge variant={badge.variant}>{badge.label}</Badge></td>
                  <td className="text-surface-600 dark:text-surface-300">{row.narration || '-'}</td>
                  <td className="text-right font-medium text-red-600 dark:text-red-400">
                    {row.debit != null ? formatCurrency(row.debit) : ''}
                  </td>
                  <td className="text-right font-medium text-green-600 dark:text-green-400">
                    {row.credit != null ? formatCurrency(row.credit) : ''}
                  </td>
                  <td className={cn(
                    'text-right font-medium',
                    row.balance > 0 ? 'text-red-600 dark:text-red-400' : row.balance < 0 ? 'text-green-600 dark:text-green-400' : '',
                  )}>
                    {formatCurrency(Math.abs(row.balance))}
                    {row.balance !== 0 && <span className="text-xs ml-1">{row.balance > 0 ? 'Dr' : 'Cr'}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-surface-300 dark:border-surface-600">
              <td colSpan={3} className="font-semibold text-surface-900 dark:text-white">Totals</td>
              <td className="text-right font-semibold text-red-600 dark:text-red-400">{formatCurrency(totalDebits)}</td>
              <td className="text-right font-semibold text-green-600 dark:text-green-400">{formatCurrency(totalCredits)}</td>
              <td className={cn(
                'text-right font-semibold',
                finalBalance > 0 ? 'text-red-600 dark:text-red-400' : finalBalance < 0 ? 'text-green-600 dark:text-green-400' : '',
              )}>
                {formatCurrency(Math.abs(finalBalance))}
                {finalBalance !== 0 && <span className="text-xs ml-1">{finalBalance > 0 ? 'Dr' : 'Cr'}</span>}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
