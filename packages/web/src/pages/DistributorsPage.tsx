import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import {
  HiOutlinePlus,
  HiOutlinePencilSquare,
  HiOutlineMagnifyingGlass,
  HiOutlineEye,
} from 'react-icons/hi2';
import {
  type Distributor,
  type GstinLookupResult,
  DistributorStatus,
  GstMode,
  createDistributorSchema,
  updateDistributorSchema,
  type UpdateDistributorInput,
  INDIAN_STATE_NAMES,
} from '@gaslink/shared';
import { apiGet, apiPost, apiPut, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Combobox, Modal, Badge, Loader, EmptyState } from '@/components/ui';

const PROVIDER_CODES = ['IOCL', 'HPCL', 'BPCL', 'GOGAS', 'SUPERGAS', 'TOTALGAS', 'OTHERS'] as const;

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
  const navigate = useNavigate();
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
                <th>Providers</th>
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
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {(dist.providerCodes || []).map(code => (
                        <span key={code} className="text-xs px-1.5 py-0.5 rounded bg-surface-100 dark:bg-surface-700 text-surface-700 dark:text-surface-300 font-medium">{code}</span>
                      ))}
                      {!(dist.providerCodes?.length) && <span className="text-xs text-surface-400">-</span>}
                    </div>
                  </td>
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
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => navigate(`/app/distributors/${dist.distributorId}`)}
                        className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500"
                        title="View Details"
                      >
                        <HiOutlineEye className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setEditDistributor(dist)}
                        className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-500"
                        title="Edit"
                      >
                        <HiOutlinePencilSquare className="h-4 w-4" />
                      </button>
                    </div>
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

// ─── GSTIN Lookup response shape from our API ────────────────────────────────

interface GstinLookupResponse extends GstinLookupResult {
  registrationDate: string | null;
  additionalAddresses: Array<{
    address: string;
    city: string;
    state: string;
    stateCode: string;
    pincode: string;
  }>;
  coordinates: { latitude: number; longitude: number } | null;
}

// ─── Form Modal ──────────────────────────────────────────────────────────────

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

  const [gstinInput, setGstinInput] = useState(distributor?.gstin || '');
  const [gstinLookupData, setGstinLookupData] = useState<GstinLookupResponse | null>(null);
  const [godownSameAsRegistered, setGodownSameAsRegistered] = useState(false);
  const [officeSameAsRegistered, setOfficeSameAsRegistered] = useState(false);
  const [selectedProviders, setSelectedProviders] = useState<string[]>(distributor?.providerCodes || []);

  const { register, handleSubmit, setValue, watch, control, formState: { errors } } = useForm<UpdateDistributorInput>({
    resolver: zodResolver(isEdit ? updateDistributorSchema : createDistributorSchema),
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
          latitude: distributor.latitude ?? undefined,
          longitude: distributor.longitude ?? undefined,
          godownAddress: distributor.godownAddress || '',
          godownCity: distributor.godownCity || '',
          godownState: distributor.godownState || '',
          godownPincode: distributor.godownPincode || '',
          godownLatitude: distributor.godownLatitude ?? undefined,
          godownLongitude: distributor.godownLongitude ?? undefined,
          officeAddress: distributor.officeAddress || '',
          officeCity: distributor.officeCity || '',
          officeState: distributor.officeState || '',
          officePincode: distributor.officePincode || '',
          // Group A Step 6: gstMode is no longer writable here. Use the
          // GST Activation flow on the distributor detail page instead.
          status: distributor.status,
          subscriptionPlan: distributor.subscriptionPlan ?? null,
          billingTier: distributor.billingTier ?? null,
          gaslinkBillingEnabled: distributor.gaslinkBillingEnabled,
        }
      : { businessName: '', legalName: '' },
  });

  // Watch registered address for "same as" copy
  const regAddress = watch('address');
  const regCity = watch('city');
  const regState = watch('state');
  const regPincode = watch('pincode');

  // Group D1 (2026-06-11): memoised state-options for the Combobox.
  const stateOptions = useMemo(
    () => INDIAN_STATE_NAMES.map((n: string) => ({ value: n, label: n })),
    [],
  );

  const gstinLookup = useMutation({
    mutationFn: (gstin: string) =>
      apiGet<GstinLookupResponse>(`/distributors/gstin-lookup/${gstin}`),
    onSuccess: (data) => {
      setGstinLookupData(data);

      // Auto-populate form fields
      setValue('gstin', data.gstin);
      setValue('legalName', data.legalName);
      setValue('businessName', data.tradeName || data.legalName);
      setValue('address', data.address);
      setValue('city', data.city);
      setValue('state', data.state);
      setValue('pincode', data.pincode);

      // Set registered address coordinates if available
      if (data.coordinates) {
        setValue('latitude', data.coordinates.latitude);
        setValue('longitude', data.coordinates.longitude);
      }

      // Update the GSTIN input field
      setGstinInput(data.gstin);

      toast.success(`GSTIN verified: ${data.legalName} (${data.status})`);
    },
    onError: (error) => {
      toast.error(getErrorMessage(error));
    },
  });

  // Geocode godown address
  const geocodeGodown = useMutation({
    mutationFn: (addr: { address: string; city: string; state: string; pincode: string }) =>
      apiPost<{ latitude: number; longitude: number }>('/distributors/geocode', addr),
    onSuccess: (data) => {
      setValue('godownLatitude', data.latitude);
      setValue('godownLongitude', data.longitude);
      toast.success('Godown location geocoded');
    },
    onError: () => {
      toast.error('Could not geocode godown address');
    },
  });

  const mutation = useMutation({
    mutationFn: (data: UpdateDistributorInput) =>
      isEdit ? apiPut(`/distributors/${distributor.distributorId}`, data) : apiPost('/distributors', data),
    onSuccess: () => {
      toast.success(isEdit ? 'Distributor updated' : 'Distributor created');
      queryClient.invalidateQueries({ queryKey: ['distributors'] });
      queryClient.invalidateQueries({ queryKey: ['distributors-list'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  function handleGetGstin() {
    const trimmed = gstinInput.trim().toUpperCase();
    if (!trimmed) {
      toast.error('Please enter a GSTIN');
      return;
    }
    if (trimmed.length !== 15 || !/^[0-9]{2}[A-Z0-9]{13}$/.test(trimmed)) {
      toast.error('Invalid GSTIN format. Must be 15 alphanumeric characters.');
      return;
    }
    setGstinInput(trimmed);
    gstinLookup.mutate(trimmed);
  }

  function handleGodownSameToggle(checked: boolean) {
    setGodownSameAsRegistered(checked);
    if (checked) {
      setValue('godownAddress', regAddress || '');
      setValue('godownCity', regCity || '');
      setValue('godownState', regState || '');
      setValue('godownPincode', regPincode || '');
      // Copy registered coordinates to godown
      const lat = watch('latitude');
      const lng = watch('longitude');
      if (lat && lng) {
        setValue('godownLatitude', lat);
        setValue('godownLongitude', lng);
      }
    }
  }

  function handleOfficeSameToggle(checked: boolean) {
    setOfficeSameAsRegistered(checked);
    if (checked) {
      setValue('officeAddress', regAddress || '');
      setValue('officeCity', regCity || '');
      setValue('officeState', regState || '');
      setValue('officePincode', regPincode || '');
    }
  }

  function handleGeocodeGodown() {
    const godownAddr = watch('godownAddress');
    const godownCity = watch('godownCity');
    const godownState = watch('godownState');
    const godownPincode = watch('godownPincode');
    if (!godownAddr && !godownPincode) {
      toast.error('Enter a godown address or pincode first');
      return;
    }
    geocodeGodown.mutate({
      address: godownAddr || '',
      city: godownCity || '',
      state: godownState || '',
      pincode: godownPincode || '',
    });
  }

  const onSubmit = (data: UpdateDistributorInput) => {
    const payload = {
      ...data,
      providerCodes: selectedProviders,
      // Convert empty strings to null for nullable fields
      subscriptionPlan: data.subscriptionPlan || null,
      billingTier: data.billingTier || null,
    };
    mutation.mutate(payload);
  };

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Distributor' : 'Add Distributor'} size="lg">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">

        {/* ── Step 1: GSTIN Lookup ──────────────────────────────────── */}
        <div className="card p-4 bg-primary-50 dark:bg-primary-900/20 border-primary-200 dark:border-primary-800">
          <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-3">
            Step 1: Fetch Business Details via GSTIN
          </h3>
          <div className="flex gap-2">
            <div className="flex-1">
              <input
                type="text"
                placeholder="Enter GSTIN (e.g. 29ABCDE1234F1Z5)"
                value={gstinInput}
                onChange={(e) => setGstinInput(e.target.value.toUpperCase())}
                className="input py-2 font-mono tracking-wide"
                maxLength={15}
              />
            </div>
            <Button
              type="button"
              onClick={handleGetGstin}
              loading={gstinLookup.isPending}
              disabled={gstinLookup.isPending}
            >
              {gstinLookup.isPending ? 'Fetching...' : 'Get GSTIN'}
            </Button>
          </div>
          {gstinLookupData && (
            <div className="mt-3 text-xs space-y-1 text-surface-600 dark:text-surface-400">
              <div className="flex gap-4 flex-wrap">
                <span><strong>Status:</strong> <Badge variant={gstinLookupData.status === 'Active' ? 'success' : 'danger'}>{gstinLookupData.status}</Badge></span>
                <span><strong>Type:</strong> {gstinLookupData.registrationType || 'N/A'}</span>
                <span><strong>Business:</strong> {gstinLookupData.businessType || 'N/A'}</span>
                {gstinLookupData.registrationDate && (
                  <span><strong>Registered:</strong> {gstinLookupData.registrationDate}</span>
                )}
              </div>
              {gstinLookupData.coordinates && (
                <div className="text-green-600 dark:text-green-400">
                  Coordinates: {gstinLookupData.coordinates.latitude.toFixed(4)}, {gstinLookupData.coordinates.longitude.toFixed(4)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Registered Business Details (from GST) ──────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-3">
            GST Registered Business Details
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Business / Trade Name" required error={errors.businessName?.message} {...register('businessName')} />
            <Input label="Legal Name" required error={errors.legalName?.message} {...register('legalName')} />
            <Input label="GSTIN" className="font-mono" error={errors.gstin?.message} {...register('gstin')} readOnly={!!gstinLookupData} />
            <Input label="Phone" {...register('phone')} />
            <Input label="Email" type="email" {...register('email')} />
          </div>
        </div>

        {/* ── Registered Address ──────────────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-3">
            Registered Address
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Input label="Address" error={errors.address?.message} {...register('address')} />
            </div>
            <Input label="City" error={errors.city?.message} {...register('city')} />
            <Controller
              control={control}
              name="state"
              render={({ field }) => (
                <Combobox
                  label="State"
                  options={stateOptions}
                  value={field.value || ''}
                  onChange={field.onChange}
                  placeholder="Type to search…"
                  error={errors.state?.message}
                  disabled={!!gstinLookupData}
                  strict
                />
              )}
            />
            <Input
              label="Pincode"
              inputMode="numeric"
              maxLength={6}
              placeholder="6 digits"
              error={errors.pincode?.message}
              {...register('pincode')}
            />
          </div>
        </div>

        {/* ── Godown / Warehouse Address ──────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
              Godown / Warehouse Address
            </h3>
            <label className="flex items-center gap-2 text-xs text-surface-600 dark:text-surface-400 cursor-pointer">
              <input
                type="checkbox"
                checked={godownSameAsRegistered}
                onChange={(e) => handleGodownSameToggle(e.target.checked)}
                className="rounded border-surface-300 text-primary-600 focus:ring-primary-500"
              />
              Same as registered address
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Input
                label="Godown Address"
                {...register('godownAddress')}
                disabled={godownSameAsRegistered}
              />
            </div>
            <Input label="City" {...register('godownCity')} disabled={godownSameAsRegistered} />
            <Controller
              control={control}
              name="godownState"
              render={({ field }) => (
                <Combobox
                  label="State"
                  options={stateOptions}
                  value={field.value || ''}
                  onChange={field.onChange}
                  placeholder="Type to search…"
                  error={errors.godownState?.message}
                  disabled={godownSameAsRegistered}
                  strict
                />
              )}
            />
            <Input
              label="Pincode"
              inputMode="numeric"
              maxLength={6}
              placeholder="6 digits"
              error={errors.godownPincode?.message}
              {...register('godownPincode')}
              disabled={godownSameAsRegistered}
            />
            <div className="flex items-end">
              <Button
                type="button"
                variant="secondary"
                onClick={handleGeocodeGodown}
                loading={geocodeGodown.isPending}
                disabled={godownSameAsRegistered && !!watch('godownLatitude')}
                className="w-full"
              >
                {watch('godownLatitude') ? `Located (${watch('godownLatitude')?.toFixed(4)}, ${watch('godownLongitude')?.toFixed(4)})` : 'Get Coordinates'}
              </Button>
            </div>
          </div>
        </div>

        {/* ── Office Address ──────────────────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
              Office Address
            </h3>
            <label className="flex items-center gap-2 text-xs text-surface-600 dark:text-surface-400 cursor-pointer">
              <input
                type="checkbox"
                checked={officeSameAsRegistered}
                onChange={(e) => handleOfficeSameToggle(e.target.checked)}
                className="rounded border-surface-300 text-primary-600 focus:ring-primary-500"
              />
              Same as registered address
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Input
                label="Office Address"
                {...register('officeAddress')}
                disabled={officeSameAsRegistered}
              />
            </div>
            <Input label="City" {...register('officeCity')} disabled={officeSameAsRegistered} />
            <Controller
              control={control}
              name="officeState"
              render={({ field }) => (
                <Combobox
                  label="State"
                  options={stateOptions}
                  value={field.value || ''}
                  onChange={field.onChange}
                  placeholder="Type to search…"
                  error={errors.officeState?.message}
                  disabled={officeSameAsRegistered}
                  strict
                />
              )}
            />
            <Input
              label="Pincode"
              inputMode="numeric"
              maxLength={6}
              placeholder="6 digits"
              error={errors.officePincode?.message}
              {...register('officePincode')}
              disabled={officeSameAsRegistered}
            />
          </div>
        </div>

        {/* ── Additional Addresses from GST ───────────────────────── */}
        {gstinLookupData && gstinLookupData.additionalAddresses.length > 0 && (
          <div className="card p-4 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800">
            <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-2">
              Additional Addresses from GST ({gstinLookupData.additionalAddresses.length})
            </h3>
            <p className="text-xs text-surface-500 dark:text-surface-400 mb-3">
              These addresses are registered with GST. You can use them for godown/office above.
            </p>
            <div className="space-y-2">
              {gstinLookupData.additionalAddresses.map((addr, i) => (
                <div key={i} className="flex items-start gap-2 p-2 rounded bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
                  <div className="flex-1 text-xs">
                    <p className="font-medium">{addr.address}</p>
                    <p className="text-surface-500">{addr.city}, {addr.state} - {addr.pincode}</p>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      type="button"
                      className="text-xs px-2 py-1 rounded bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 hover:bg-primary-200 dark:hover:bg-primary-900/50"
                      onClick={() => {
                        setValue('godownAddress', addr.address);
                        setValue('godownCity', addr.city);
                        setValue('godownState', addr.state);
                        setValue('godownPincode', addr.pincode);
                        setGodownSameAsRegistered(false);
                        toast.success('Applied to godown address');
                      }}
                    >
                      Use as Godown
                    </button>
                    <button
                      type="button"
                      className="text-xs px-2 py-1 rounded bg-surface-100 dark:bg-surface-700 text-surface-700 dark:text-surface-300 hover:bg-surface-200 dark:hover:bg-surface-600"
                      onClick={() => {
                        setValue('officeAddress', addr.address);
                        setValue('officeCity', addr.city);
                        setValue('officeState', addr.state);
                        setValue('officePincode', addr.pincode);
                        setOfficeSameAsRegistered(false);
                        toast.success('Applied to office address');
                      }}
                    >
                      Use as Office
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Admin Settings (Status, Plan, Billing) ────────────────── */}
        {/* Group A Step 6: GST Mode is no longer editable here. Use the
            "Configure GST" button on the distributor detail page instead. */}
        {isEdit && (
          <div>
            <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-3">
              Admin Settings
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Select
                label="Status"
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'suspended', label: 'Suspended' },
                  { value: 'inactive', label: 'Inactive' },
                ]}
                {...register('status')}
              />
              <Select
                label="Subscription Plan"
                options={[
                  { value: '', label: 'No Plan' },
                  { value: 'starter', label: 'Starter (₹4,999/mo)' },
                  { value: 'growth', label: 'Growth (₹8,999/mo)' },
                  { value: 'business', label: 'Business (₹14,999/mo)' },
                  { value: 'enterprise', label: 'Enterprise (₹19,999/mo)' },
                ]}
                {...register('subscriptionPlan')}
              />
              <Select
                label="Billing Tier"
                options={[
                  { value: '', label: 'No Tier' },
                  { value: 'tier_1', label: 'Tier 1 (Starter)' },
                  { value: 'tier_2', label: 'Tier 2 (Growth)' },
                  { value: 'tier_3', label: 'Tier 3 (Business)' },
                  { value: 'tier_4', label: 'Tier 4 (Enterprise)' },
                ]}
                {...register('billingTier')}
              />
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    {...register('gaslinkBillingEnabled')}
                    className="rounded border-surface-300 text-brand-600 focus:ring-brand-500 h-5 w-5"
                  />
                  <span className="text-sm font-medium text-surface-700 dark:text-surface-300">Enable GasLink Billing</span>
                </label>
              </div>
            </div>
          </div>
        )}

        {/* ── Provider Codes ─────────────────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-3">
            LPG Providers
          </h3>
          <p className="text-xs text-surface-500 dark:text-surface-400 mb-3">
            Select which LPG providers this distributor works with. Cylinder types from the provider catalog will be available based on selection.
          </p>
          <div className="flex flex-wrap gap-2">
            {PROVIDER_CODES.map((code) => (
              <label
                key={code}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                  selectedProviders.includes(code)
                    ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300'
                    : 'border-surface-300 dark:border-surface-600 hover:border-surface-400 dark:hover:border-surface-500'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedProviders.includes(code)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedProviders([...selectedProviders, code]);
                    } else {
                      setSelectedProviders(selectedProviders.filter(c => c !== code));
                    }
                  }}
                  className="rounded border-surface-300 text-brand-600 focus:ring-brand-500"
                />
                <span className="text-sm font-medium">{code}</span>
              </label>
            ))}
          </div>
        </div>

        {/* ── Actions ──────────────────────────────────────────────── */}
        <div className="flex justify-end gap-3 pt-4 border-t border-surface-200 dark:border-surface-700">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>{isEdit ? 'Update' : 'Create Distributor'}</Button>
        </div>
      </form>
    </Modal>
  );
}
