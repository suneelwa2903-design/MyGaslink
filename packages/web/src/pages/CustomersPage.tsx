import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray, useWatch, Controller, type Resolver } from 'react-hook-form';
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
  HiOutlineDocumentArrowDown,
} from 'react-icons/hi2';
import {
  type Customer,
  type CylinderType,
  type PaginationMeta,
  type Order,
  type Invoice,
  type Payment,
  type LedgerEntry,
  CustomerStatus,
  createCustomerSchema,
  type CreateCustomerInput,
  UserRole,
  INDIAN_STATE_NAMES,
} from '@gaslink/shared';
import { api, apiGet, apiPost, apiPut, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Combobox, Modal, Badge, Loader, EmptyState } from '@/components/ui';
import { useAuthStore, selectRole } from '@/stores/authStore';
import { cn } from '@/lib/cn';

const STATUS_MAP: Record<string, { variant: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  [CustomerStatus.ACTIVE]: { variant: 'success', label: 'Active' },     // green
  [CustomerStatus.SUSPENDED]: { variant: 'warning', label: 'Suspended' }, // amber
  [CustomerStatus.INACTIVE]: { variant: 'neutral', label: 'Inactive' },   // grey — was 'danger' (red) before
};

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
}

export default function CustomersPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'' | 'B2B' | 'B2C'>('');
  const [downloading, setDownloading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null);
  const [viewCustomer, setViewCustomer] = useState<Customer | null>(null);

  const queryParams: Record<string, unknown> = { page, pageSize: 50 };
  if (search) queryParams.search = search;
  if (statusFilter) queryParams.status = statusFilter;
  if (typeFilter) queryParams.customerType = typeFilter;

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
  const distributorName = useAuthStore((s) => s.user?.distributorName ?? '');

  const handleDownloadCsv = async () => {
    setDownloading(true);
    try {
      // Always exports the full distributor's customer base, ignoring active filters.
      const result = await apiGet<{ customers: Customer[] }>('/customers', { pageSize: 1000 });
      const rows = result.customers ?? [];

      const headers = [
        'name', 'phone', 'business_name', 'gstin', 'customer_type',
        'address_line1', 'city', 'state', 'pincode', 'email', 'credit_period_days',
      ];
      const esc = (v: unknown) => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const body = rows.map((c) => [
        c.customerName, c.phone, c.businessName ?? '', c.gstin ?? '',
        c.customerType, c.billingAddressLine1 ?? '', c.billingCity ?? '',
        c.billingState ?? '', c.billingPincode ?? '', c.email ?? '',
        c.creditPeriodDays,
      ].map(esc).join(','));
      const csv = [headers.join(','), ...body].join('\n');

      // Filename: customers_<distributorSlug>_DDMmmYYYY.csv (e.g. customers_VanasthaliGasService_13Jun2026.csv)
      const slug = distributorName.replace(/\s+/g, '') || 'distributor';
      const d = new Date();
      const day = String(d.getDate()).padStart(2, '0');
      const month = d.toLocaleString('en-US', { month: 'short' });
      const year = d.getFullYear();
      const filename = `customers_${slug}_${day}${month}${year}.csv`;

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Exported ${rows.length} customers`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Customers</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Manage your customer base</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={handleDownloadCsv} loading={downloading}>
            <HiOutlineDocumentArrowDown className="h-4 w-4" />
            Download CSV
          </Button>
          {canManage && (
            <Button onClick={() => setCreateOpen(true)}>
              <HiOutlinePlus className="h-4 w-4" />
              New Customer
            </Button>
          )}
        </div>
      </div>

      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
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
            options={[{ value: 'B2B', label: 'B2B' }, { value: 'B2C', label: 'B2C' }]}
            placeholder="All Types"
            value={typeFilter}
            onChange={(e) => { setTypeFilter(e.target.value as '' | 'B2B' | 'B2C'); setPage(1); }}
          />
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

// Walks the react-hook-form errors tree and returns the count of leaf nodes
// (each individual field-level error). `errors.contacts` is an array whose
// entries are themselves nested error objects, so the contacts subtree is
// flattened separately.
type FormErrorNode = {
  message?: string;
  [key: string]: unknown;
};
function countErrors(errors: Record<string, unknown>): number {
  let n = 0;
  for (const [key, val] of Object.entries(errors)) {
    if (key === 'contacts' || key === 'cylinderDiscounts') {
      const arr = (val as FormErrorNode[] | undefined) ?? [];
      for (const row of arr) {
        if (!row) continue;
        for (const k of Object.keys(row)) {
          if ((row as FormErrorNode)[k] && typeof (row as FormErrorNode)[k] === 'object') n += 1;
        }
      }
    } else if (val && typeof val === 'object' && (val as FormErrorNode).message) {
      n += 1;
    }
  }
  return n;
}

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
  const role = useAuthStore(selectRole);
  const canEditTransport = role === UserRole.DISTRIBUTOR_ADMIN || role === UserRole.SUPER_ADMIN;
  const canEditStatus =
    role === UserRole.DISTRIBUTOR_ADMIN ||
    role === UserRole.SUPER_ADMIN ||
    role === UserRole.FINANCE;

  // Account status is edit-only. The PUT /customers/:id endpoint accepts it
  // (see updateCustomerSchema in @gaslink/shared). We hold it outside RHF
  // because createCustomerSchema — which the form resolver uses — has no
  // `status` field.
  const [accountStatus, setAccountStatus] = useState<CustomerStatus>(
    (customer?.status as CustomerStatus | undefined) ?? CustomerStatus.ACTIVE,
  );
  const STATUS_HELPER: Record<CustomerStatus, string> = {
    [CustomerStatus.ACTIVE]: 'Customer can place orders normally.',
    [CustomerStatus.SUSPENDED]: 'Supply is paused. Customer cannot place new orders.',
    [CustomerStatus.INACTIVE]: 'Account closed. Customer will not appear in order search.',
  };

  const { register, handleSubmit, control, getValues, setValue, formState: { errors } } = useForm<CreateCustomerInput>({
    resolver: zodResolver(createCustomerSchema) as Resolver<CreateCustomerInput>,
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
          transportChargePerCylinder: customer.transportChargePerCylinder ?? 0,
          // 5%-eligible food-service customer vs default 18%. Stored as
          // either 5 or null (we map null → 18 for the select; 18 sent
          // back is harmless because the service writes null when the
          // value matches the platform default).
          gstRateOverride: (customer.gstRateOverride === 5 ? 5 : 18) as 5 | 18,
          contacts: customer.contacts.map((c) => ({ name: c.name, phone: c.phone, email: c.email || '', isPrimary: c.isPrimary })),
          cylinderDiscounts: customer.cylinderDiscounts.map((d) => ({ cylinderTypeId: d.cylinderTypeId, discountPerUnit: d.discountPerUnit })),
        }
      : {
          customerName: '',
          phone: '',
          creditPeriodDays: 30,
          transportChargePerCylinder: 0,
          gstRateOverride: 18 as 5 | 18,
          contacts: [],
          cylinderDiscounts: [],
        },
  });

  const contactFields = useFieldArray({ control, name: 'contacts' });
  const discountFields = useFieldArray({ control, name: 'cylinderDiscounts' });

  // Group D1 (2026-06-11): state-name list for Combobox, memoised so the
  // option array identity is stable across renders.
  const stateOptions = useMemo(
    () => INDIAN_STATE_NAMES.map((n: string) => ({ value: n, label: n })),
    [],
  );

  // Group D1: "Shipping address same as billing address" toggle.
  // Auto-enabled on edit when all 5 shipping fields are non-empty AND
  // exactly equal to their billing counterparts. Default OFF on create
  // (many commercial customers have different delivery addresses).
  const detectSameAddress = (c: Customer | undefined): boolean => {
    if (!c) return false;
    const billing = [c.billingAddressLine1, c.billingAddressLine2, c.billingCity, c.billingState, c.billingPincode];
    const shipping = [c.shippingAddressLine1, c.shippingAddressLine2, c.shippingCity, c.shippingState, c.shippingPincode];
    // All non-empty and pairwise equal.
    if (billing.some((v) => !v) || shipping.some((v) => !v)) return false;
    return billing.every((v, i) => v === shipping[i]);
  };
  const [shippingSameAsBilling, setShippingSameAsBilling] = useState<boolean>(() => detectSameAddress(customer));

  // When the toggle is ON, mirror billing → shipping for the 5 fields.
  // We subscribe to the billing values so a subsequent edit to billing
  // propagates immediately while the toggle stays on. useWatch (not
  // watch()) — react-hook-form's watch() returns a non-stable callable
  // that React Compiler can't safely memoize.
  const billingLine1 = useWatch({ control, name: 'billingAddressLine1' });
  const billingLine2 = useWatch({ control, name: 'billingAddressLine2' });
  const billingCity = useWatch({ control, name: 'billingCity' });
  const billingStateValue = useWatch({ control, name: 'billingState' });
  const billingPincodeValue = useWatch({ control, name: 'billingPincode' });
  useEffect(() => {
    if (!shippingSameAsBilling) return;
    const opts = { shouldDirty: true } as const;
    setValue('shippingAddressLine1', billingLine1 || '', opts);
    setValue('shippingAddressLine2', billingLine2 || '', opts);
    setValue('shippingCity', billingCity || '', opts);
    setValue('shippingState', billingStateValue || '', opts);
    setValue('shippingPincode', billingPincodeValue || '', opts);
  }, [shippingSameAsBilling, billingLine1, billingLine2, billingCity, billingStateValue, billingPincodeValue, setValue]);

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
  const gstinValue = useWatch({ control, name: 'gstin' });

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

  // Group E1 (2026-06-11): save-side warnings (duplicate GSTIN, etc.).
  // When the API returns { ..., warnings: string[] }, we close the modal
  // (the save succeeded) but show an amber toast for each warning so the
  // operator sees that another customer already uses this GSTIN.
  const mutation = useMutation({
    mutationFn: (data: CreateCustomerInput) =>
      isEdit
        ? apiPut<{ warnings?: string[] }>(`/customers/${customer.customerId}`, {
            ...data,
            // Only attach status when the operator has permission AND it
            // actually changed — keeps non-finance / non-admin role payloads
            // untouched, so existing inventory edits don't trip the route's
            // status guard.
            ...(canEditStatus && accountStatus !== customer.status ? { status: accountStatus } : {}),
          })
        : apiPost<{ warnings?: string[] }>('/customers', data),
    onSuccess: (response) => {
      const warnings = response?.warnings ?? [];
      toast.success(isEdit ? 'Customer updated' : 'Customer created');
      for (const w of warnings) {
        toast(w, { icon: '⚠️', duration: 6000 });
      }
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

  // Ref + invalid-submit handler so validation errors below the fold actually
  // surface to the admin. Before this, ANY validation failure (missing
  // customer name, short main phone, contact phone format, etc.) caused
  // handleSubmit to silently no-op — the user saw no toast, no scroll, no
  // banner. The inline `.error-text` paragraphs were in the DOM but
  // typically below the fold on a tall modal.
  // Two failure modes converge here:
  //   1. Errors anywhere on the form  → top-level banner + scroll to first
  //      error + toast.
  //   2. Errors specifically in the contacts subtree → additionally show the
  //      per-section banner above the contact rows so the admin sees which
  //      row needs fixing.
  const formRef = useRef<HTMLFormElement | null>(null);
  const contactsSectionRef = useRef<HTMLDivElement | null>(null);
  const [submitErrorCount, setSubmitErrorCount] = useState(0);
  const onInvalid = useCallback((formErrors: typeof errors) => {
    const count = countErrors(formErrors);
    setSubmitErrorCount(count);
    if (formErrors.contacts) {
      toast.error('Please fix the errors in the Contacts section before saving.');
      contactsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    toast.error(
      count === 1
        ? 'Please fix the highlighted field before saving.'
        : `Please fix ${count} highlighted fields before saving.`,
    );
    // Scroll to the first input whose name matches a key with errors.
    const firstErrorKey = Object.keys(formErrors)[0];
    const firstInput = formRef.current?.querySelector(
      `[name="${firstErrorKey}"]`,
    ) as HTMLElement | null;
    (firstInput ?? formRef.current)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    firstInput?.focus?.();
  }, []);
  const contactErrorCount = Array.isArray(errors.contacts)
    ? errors.contacts.filter(Boolean).length
    : 0;

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Customer' : 'New Customer'} size="xl">
      <form
        ref={formRef}
        // React Compiler's `react-hooks/refs` rule flags the onInvalid
        // argument because its body reads formRef.current and
        // contactsSectionRef.current and the compiler can't statically
        // prove that react-hook-form's handleSubmit only fires it on
        // submit (it does — handleSubmit returns an event handler, the
        // inner callbacks run on submit, never during render). useCallback
        // alone doesn't satisfy the rule. Disabling at the argument site
        // is the documented escape hatch when the closure is genuinely
        // event-time only.
        onSubmit={handleSubmit(
          (data) => {
            setSubmitErrorCount(0);
            mutation.mutate(data as CreateCustomerInput);
          },
          // eslint-disable-next-line react-hooks/refs
          onInvalid,
        )}
        className="space-y-6"
      >
        {submitErrorCount > 0 && (
          <div
            role="alert"
            className="sticky top-0 z-10 -mx-1 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 shadow-sm dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300"
          >
            {submitErrorCount === 1
              ? '1 field needs attention — scroll to the highlighted row.'
              : `${submitErrorCount} fields need attention — scroll to the highlighted rows.`}
          </div>
        )}
        {/* Basic Info */}
        <div>
          <h3 className="text-sm font-semibold text-surface-900 dark:text-white mb-3">Basic Information</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Customer Name" required error={errors.customerName?.message} {...register('customerName')} />
            <Input label="Business Name" {...register('businessName')} />
            <Input label="Phone" required error={errors.phone?.message} {...register('phone')} />
            <Input label="Email" type="email" {...register('email')} />
            {isEdit && canEditStatus && (
              <div>
                <Select
                  label="Account Status"
                  value={accountStatus}
                  onChange={(e) => setAccountStatus(e.target.value as CustomerStatus)}
                  options={[
                    { value: CustomerStatus.ACTIVE, label: 'Active' },
                    { value: CustomerStatus.SUSPENDED, label: 'Suspended' },
                    { value: CustomerStatus.INACTIVE, label: 'Inactive' },
                  ]}
                />
                <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
                  {STATUS_HELPER[accountStatus]}
                </p>
              </div>
            )}
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
            {canEditTransport && (
              <Input
                label="Transport Charge (₹/cylinder, GST incl.)"
                type="number"
                step="0.01"
                min="0"
                error={errors.transportChargePerCylinder?.message}
                {...register('transportChargePerCylinder', { valueAsNumber: true })}
              />
            )}
            {/* Per-customer GST rate. 5% applies to food-service customers
                (hotels / restaurants / canteens using LPG for cooking) per
                the commercial-LPG-eligibility rate notification. 18% is
                the default for everyone else. Driver of InvoiceItem.gstRate
                at issue time — see invoiceService.createInvoiceFromOrder. */}
            <div>
              <Controller
                control={control}
                name="gstRateOverride"
                render={({ field }) => (
                  <Select
                    label="GST Rate"
                    value={String(field.value ?? 18)}
                    onChange={(e) => field.onChange(Number(e.target.value) as 5 | 18)}
                    options={[
                      { value: '18', label: '18%' },
                      { value: '5', label: '5%' },
                    ]}
                  />
                )}
              />
              <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
                5% applies to customers using LPG for food preparation (hotels, restaurants, canteens).
              </p>
            </div>
          </div>
        </div>

        {/* Billing Address */}
        <div>
          <h3 className="text-sm font-semibold text-surface-900 dark:text-white mb-3">Billing Address</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Address Line 1" {...register('billingAddressLine1')} />
            <Input label="Address Line 2" {...register('billingAddressLine2')} />
            <Input label="City" {...register('billingCity')} />
            <Controller
              control={control}
              name="billingState"
              render={({ field }) => (
                <Combobox
                  label="State"
                  options={stateOptions}
                  value={field.value || ''}
                  onChange={field.onChange}
                  placeholder="Type to search…"
                  error={errors.billingState?.message}
                  strict
                />
              )}
            />
            <Input
              label="Pincode"
              inputMode="numeric"
              maxLength={6}
              placeholder="6 digits"
              error={errors.billingPincode?.message}
              {...register('billingPincode')}
            />
          </div>
        </div>

        {/* Shipping Address */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-white">Shipping Address</h3>
            <label className="flex items-center gap-2 text-xs text-surface-600 dark:text-surface-400 cursor-pointer">
              <input
                type="checkbox"
                checked={shippingSameAsBilling}
                onChange={(e) => setShippingSameAsBilling(e.target.checked)}
                className="rounded border-surface-300 text-brand-600 focus:ring-brand-500"
              />
              Shipping address same as billing address
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Address Line 1"
              disabled={shippingSameAsBilling}
              {...register('shippingAddressLine1')}
            />
            <Input
              label="Address Line 2"
              disabled={shippingSameAsBilling}
              {...register('shippingAddressLine2')}
            />
            <Input
              label="City"
              disabled={shippingSameAsBilling}
              {...register('shippingCity')}
            />
            <Controller
              control={control}
              name="shippingState"
              render={({ field }) => (
                <Combobox
                  label="State"
                  options={stateOptions}
                  value={field.value || ''}
                  onChange={field.onChange}
                  placeholder="Type to search…"
                  error={errors.shippingState?.message}
                  disabled={shippingSameAsBilling}
                  strict
                />
              )}
            />
            <Input
              label="Pincode"
              inputMode="numeric"
              maxLength={6}
              placeholder="6 digits"
              disabled={shippingSameAsBilling}
              error={errors.shippingPincode?.message}
              {...register('shippingPincode')}
            />
          </div>
        </div>

        {/* Contacts */}
        <div ref={contactsSectionRef}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-white">Contacts</h3>
            <Button type="button" variant="ghost" size="sm" onClick={() => contactFields.append({ name: '', phone: '', email: '', isPrimary: false })}>
              <HiOutlinePlus className="h-3 w-3" />Add Contact
            </Button>
          </div>
          {contactErrorCount > 0 && (
            <div
              role="alert"
              className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300"
            >
              {contactErrorCount === 1
                ? '1 contact has an invalid field — see highlighted row below.'
                : `${contactErrorCount} contacts have invalid fields — see highlighted rows below.`}
            </div>
          )}
          {contactFields.fields.map((field, index) => (
            <div key={field.id} className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-3 p-3 bg-surface-50 dark:bg-surface-800/50 rounded-xl">
              <Input placeholder="Name" required error={errors.contacts?.[index]?.name?.message} {...register(`contacts.${index}.name`)} />
              <Input placeholder="Phone (optional)" error={errors.contacts?.[index]?.phone?.message} {...register(`contacts.${index}.phone`)} />
              <Input placeholder="Email" error={errors.contacts?.[index]?.email?.message} {...register(`contacts.${index}.email`)} />
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
  const [tab, setTab] = useState<'orders' | 'invoices' | 'payments' | 'ledger' | 'balances'>('orders');

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

  const { data: ledgerEntries, isLoading: ledgerLoading } = useQuery({
    queryKey: ['customer-ledger', customer.customerId],
    queryFn: () => apiGet<LedgerEntry[]>(`/payments/ledger/${customer.customerId}`),
    enabled: tab === 'ledger',
  });

  const [ledgerFrom, setLedgerFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [ledgerTo, setLedgerTo] = useState(() => new Date().toISOString().split('T')[0]);

  const handleDownloadStatement = async () => {
    try {
      const resp = await api.get(`/customers/${customer.customerId}/ledger/pdf`, {
        params: { from: ledgerFrom, to: ledgerTo },
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement-${customer.customerName}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to download statement');
    }
  };

  const tabs = [
    { key: 'orders' as const, label: 'Orders' },
    { key: 'invoices' as const, label: 'Invoices' },
    { key: 'payments' as const, label: 'Payments' },
    { key: 'ledger' as const, label: 'Ledger' },
    { key: 'balances' as const, label: 'Cylinder Balances' },
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

        {tab === 'ledger' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="label">From</label>
                <input type="date" value={ledgerFrom} onChange={(e) => setLedgerFrom(e.target.value)} className="input py-2" />
              </div>
              <div>
                <label className="label">To</label>
                <input type="date" value={ledgerTo} onChange={(e) => setLedgerTo(e.target.value)} className="input py-2" />
              </div>
              <Button variant="secondary" onClick={handleDownloadStatement}>
                <HiOutlineDocumentArrowDown className="h-4 w-4" />
                Download PDF
              </Button>
            </div>
            <LedgerTab entries={ledgerEntries ?? []} loading={ledgerLoading} />
          </div>
        )}

        {tab === 'balances' && (
          <CylinderBalancesTab customerId={customer.customerId} />
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

// Fix B (2026-06-11): per-customer cylinder balances view.
//
// Reads from GET /api/customers/:id/balance (tenant-scoped) and writes
// back through POST /api/customers/:id/balance-setup. The write endpoint
// is the same one we tenant-isolated in Group 4 (K7) — only the caller's
// own tenant can mutate.
type CylinderBalance = {
  cylinderTypeId: string;
  cylinderTypeName: string;
  withCustomerQty: number;
  pendingReturns: number;
  missingQty: number;
  updatedAt: string;
};

function CylinderBalancesTab({ customerId }: { customerId: string }) {
  const qc = useQueryClient();
  const distributorId = useAuthStore(selectRole) === 'super_admin' ? null : null;
  const { data: balances, isLoading: balancesLoading } = useQuery({
    queryKey: ['customer-balances', customerId],
    queryFn: () => apiGet<{ balances: CylinderBalance[] }>(`/customers/${customerId}/balance`).then((r) => r.balances),
  });
  const { data: cylinderTypes } = useQuery({
    queryKey: ['cylinder-types-active'],
    queryFn: () => apiGet<{ cylinderTypes: CylinderType[] }>('/cylinder-types').then((r) => r.cylinderTypes),
  });
  void distributorId; // kept for future tenant-aware additions

  // Local edit state keyed on cylinderTypeId so the operator can edit
  // every row in one shot and Save once.
  type EditState = Record<string, { withCustomerQty: string; pendingReturns: string }>;
  const [edits, setEdits] = useState<EditState>({});
  const [addType, setAddType] = useState<string>('');

  // Hydrate `edits` from server data the first time it loads. Wrapped
  // in useEffect to satisfy React's "no ref access during render" rule —
  // behavior is identical (one extra render with empty edits) because
  // the TanStack Query loading state already gates the UI above.
  const editsRef = useRef(false);
  useEffect(() => {
    if (balances && !editsRef.current) {
      editsRef.current = true;
      const seed: EditState = {};
      for (const b of balances) {
        seed[b.cylinderTypeId] = {
          withCustomerQty: String(b.withCustomerQty),
          pendingReturns: String(b.pendingReturns),
        };
      }
      setEdits(seed);
    }
  }, [balances]);

  const usedTypeIds = new Set(Object.keys(edits));
  const availableToAdd = (cylinderTypes ?? []).filter((t) => !usedTypeIds.has(t.cylinderTypeId));

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        balances: Object.entries(edits).map(([cylinderTypeId, v]) => ({
          cylinderTypeId,
          withCustomerQty: Math.max(0, Math.floor(Number(v.withCustomerQty) || 0)),
          pendingReturns: Math.max(0, Math.floor(Number(v.pendingReturns) || 0)),
        })),
      };
      return apiPost<CylinderBalance[]>(`/customers/${customerId}/balance-setup`, payload);
    },
    onSuccess: () => {
      toast.success('Opening cylinder balances saved');
      editsRef.current = false; // re-hydrate from fresh server data
      qc.invalidateQueries({ queryKey: ['customer-balances', customerId] });
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  if (balancesLoading) return <div className="flex justify-center py-8"><Loader /></div>;

  const rows = Object.entries(edits);

  return (
    <div className="space-y-4">
      <p className="text-xs text-surface-500 dark:text-surface-400">
        Set how many empty cylinders this customer currently holds — used by the daily
        deliveries to reconcile what is returned. Blank rows are skipped.
      </p>

      {rows.length === 0 && availableToAdd.length === 0 && (
        <EmptyState title="No cylinder types available" />
      )}

      {rows.length > 0 && (
        <div className="table-container">
          <table className="table">
            {/*
              2026-06-11: `pendingReturns` is intentionally hidden from
              the UI per CLAUDE.md "open items". The DB column, schema
              type, and service writes are all retained; the save payload
              below still posts a default of 0 so the backend contract is
              unchanged. Bring the column back if/when a use case lands.
            */}
            <thead>
              <tr>
                <th>Cylinder type</th>
                <th className="text-right">Empties at customer</th>
                <th className="text-right">Last updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(([typeId, v]) => {
                const meta = balances?.find((b) => b.cylinderTypeId === typeId);
                const typeName = meta?.cylinderTypeName
                  ?? (cylinderTypes ?? []).find((t) => t.cylinderTypeId === typeId)?.typeName
                  ?? typeId.slice(0, 8);
                return (
                  <tr key={typeId}>
                    <td className="font-medium">{typeName}</td>
                    <td className="text-right">
                      <input
                        type="number" min={0} className="input py-1 w-24 text-right"
                        value={v.withCustomerQty}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [typeId]: { ...prev[typeId], withCustomerQty: e.target.value } }))}
                      />
                    </td>
                    <td className="text-right text-xs text-surface-500">
                      {meta?.updatedAt ? new Date(meta.updatedAt).toLocaleDateString('en-IN') : '—'}
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        className="text-xs text-red-500 hover:underline"
                        onClick={() => setEdits((prev) => {
                          const next = { ...prev };
                          delete next[typeId];
                          return next;
                        })}
                      >Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {availableToAdd.length > 0 && (
        <div className="flex items-end gap-2">
          <div>
            <label className="label">Add cylinder type</label>
            <Select
              value={addType}
              onChange={(e) => setAddType(e.target.value)}
              placeholder="Select type…"
              options={availableToAdd.map((t) => ({
                value: t.cylinderTypeId,
                label: `${t.typeName} (${t.capacity}${t.unit})`,
              }))}
            />
          </div>
          <Button
            variant="secondary"
            disabled={!addType}
            onClick={() => {
              if (!addType) return;
              setEdits((prev) => ({ ...prev, [addType]: { withCustomerQty: '0', pendingReturns: '0' } }));
              setAddType('');
            }}
          >+ Add row</Button>
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={rows.length === 0}>Save</Button>
      </div>
    </div>
  );
}

function LedgerTab({ entries, loading }: { entries: LedgerEntry[]; loading: boolean }) {
  if (loading) return <div className="flex justify-center py-8"><Loader /></div>;
  if (!entries.length) return <EmptyState title="No ledger entries" />;

  // Group 1 (2026-06-11): pin Opening Balance rows to the top so the
  // statement reads as "Balance b/f → period transactions → closing".
  // Within each group, sort chronologically. The API already returns
  // entries with an `isOpeningBalance` flag set on the linked invoice.
  const sorted = [...entries].sort((a, b) => {
    const aOB = a.isOpeningBalance ? 0 : 1;
    const bOB = b.isOpeningBalance ? 0 : 1;
    if (aOB !== bOB) return aOB - bOB;
    return new Date(a.entryDate).getTime() - new Date(b.entryDate).getTime();
  });

  const rows: Array<LedgerEntry & { debit: number | null; credit: number | null; balance: number }> = [];
  let runningBalance = 0;
  for (const entry of sorted) {
    runningBalance += entry.amountDelta;
    const debit = entry.amountDelta > 0 ? entry.amountDelta : null;
    const credit = entry.amountDelta < 0 ? Math.abs(entry.amountDelta) : null;
    rows.push({ ...entry, debit, credit, balance: runningBalance });
  }

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
              <th className="text-right">Empties Coll.</th>
              <th className="text-right">Pending Emp.</th>
              <th className="text-right">Empties Cost</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
              <th className="text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const badge = row.isOpeningBalance
                ? { variant: 'neutral' as const, label: 'Balance b/f' }
                : LEDGER_TYPE_BADGE[row.entryType] ?? { variant: 'neutral' as const, label: row.entryType };
              // Only invoice-type entries (non-OB) get the empties columns.
              // The wire value carries Prisma's TS-side enum name
              // (`invoice_entry`), not the @map'd wire form (`invoice`) — see
              // anti-pattern #9. Accept both shapes defensively.
              const et = row.entryType as string;
              const showEmpties = !row.isOpeningBalance && (et === 'invoice_entry' || et === 'invoice');
              return (
                <tr
                  key={row.id}
                  className={cn(
                    row.isOpeningBalance && 'bg-surface-50 dark:bg-surface-800/40 italic',
                  )}
                >
                  <td className="whitespace-nowrap">{new Date(row.entryDate).toLocaleDateString('en-IN')}</td>
                  <td><Badge variant={badge.variant}>{badge.label}</Badge></td>
                  <td className="text-surface-600 dark:text-surface-300">{row.narration || '-'}</td>
                  <td className="text-right text-surface-600 dark:text-surface-300">
                    {showEmpties && (row.emptyCylsCollected ?? 0) > 0 ? row.emptyCylsCollected : ''}
                  </td>
                  <td className="text-right text-surface-600 dark:text-surface-300">
                    {showEmpties && (row.pendingEmptyCyls ?? 0) > 0 ? row.pendingEmptyCyls : ''}
                  </td>
                  <td className="text-right text-surface-600 dark:text-surface-300">
                    {showEmpties && (row.emptyCylsCost ?? 0) > 0 ? formatCurrency(row.emptyCylsCost ?? 0) : ''}
                  </td>
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
              <td colSpan={6} className="font-semibold text-surface-900 dark:text-white">Totals</td>
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
