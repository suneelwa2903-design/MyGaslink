import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import {
  HiOutlineCog6Tooth,
  HiOutlineShieldCheck,
  HiOutlineExclamationTriangle,
  HiOutlineCheckCircle,
  HiOutlineUsers,
  HiOutlineDocumentText,
  HiOutlinePlus,
  HiOutlinePencilSquare,
  HiOutlineTrash,
  HiOutlineCurrencyRupee,
  HiOutlineCube,
  HiOutlineDocumentArrowDown,
} from 'react-icons/hi2';
import {
  type DistributorSettings,
  type CylinderThreshold,
  type ApprovalWorkflowConfig,
  type User,
  type License,
  GstMode,
  UserRole,
  LicenseType,
  gstCredentialsSchema,
  type GstCredentialsInput,
  createUserSchema,
  type CreateUserInput,
} from '@gaslink/shared';
import { api, apiGet, apiPost, apiPut, apiDelete, getErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';
import { OnboardingTab } from '@/components/OnboardingTab';

export default function SettingsPage() {
  const { user } = useAuthStore();
  const showPrices = user?.role === UserRole.SUPER_ADMIN || user?.role === UserRole.DISTRIBUTOR_ADMIN;
  const showOnboarding = user?.role === UserRole.SUPER_ADMIN || user?.role === UserRole.DISTRIBUTOR_ADMIN;
  const initialTab = (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('tab')) as any;
  const [tab, setTab] = useState<'onboarding' | 'general' | 'subscription' | 'gst' | 'cylinders' | 'prices' | 'thresholds' | 'approvals' | 'users' | 'licenses'>(initialTab && ['onboarding','general','subscription','gst','cylinders','prices','thresholds','approvals','users','licenses'].includes(initialTab) ? initialTab : 'general');

  const tabs = [
    ...(showOnboarding ? [{ key: 'onboarding' as const, label: 'Onboarding', icon: HiOutlineCheckCircle }] : []),
    { key: 'general' as const, label: 'General', icon: HiOutlineCog6Tooth },
    ...(showPrices ? [{ key: 'subscription' as const, label: 'Subscription', icon: HiOutlineCurrencyRupee }] : []),
    { key: 'gst' as const, label: 'GST', icon: HiOutlineShieldCheck },
    ...(showPrices ? [{ key: 'cylinders' as const, label: 'Cylinder Types', icon: HiOutlineCube }] : []),
    ...(showPrices ? [{ key: 'prices' as const, label: 'Cylinder Prices', icon: HiOutlineCurrencyRupee }] : []),
    { key: 'thresholds' as const, label: 'Thresholds', icon: HiOutlineExclamationTriangle },
    { key: 'approvals' as const, label: 'Approvals', icon: HiOutlineCheckCircle },
    { key: 'users' as const, label: 'Users', icon: HiOutlineUsers },
    { key: 'licenses' as const, label: 'Licenses', icon: HiOutlineDocumentText },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Settings</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Configure your distributor settings</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-surface-200 dark:border-surface-700 overflow-x-auto">
        <div className="flex gap-1 min-w-max">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'flex items-center gap-2 pb-2 px-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                tab === t.key ? 'border-brand-500 text-brand-600 dark:text-brand-400' : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300',
              )}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {tab === 'onboarding' && <OnboardingTab />}
      {tab === 'general' && <GeneralTab />}
      {tab === 'subscription' && <SubscriptionTab />}
      {tab === 'gst' && <GstTab />}
      {tab === 'cylinders' && <CylinderConfigTab />}
      {tab === 'prices' && <PricesTab />}
      {tab === 'thresholds' && <ThresholdsTab />}
      {tab === 'approvals' && <ApprovalsTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'licenses' && <LicensesTab />}
    </div>
  );
}

// ─── General Tab ──────────────────────────────────────────────────────────────

function GeneralTab() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiGet<DistributorSettings>('/settings'),
  });

  const { register, handleSubmit } = useForm({
    values: { pendingActionSlaHours: settings?.pendingActionSlaHours ?? {} },
  });

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiPut('/settings/general', { value: data }),
    onSuccess: () => { toast.success('Settings saved'); queryClient.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  if (isLoading) return <div className="flex justify-center py-20"><Loader size="lg" /></div>;

  return (
    <div className="card p-6 max-w-2xl space-y-6">
      <h3 className="font-semibold text-surface-900 dark:text-white">SLA Deadlines (hours)</h3>
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input label="Critical" type="number" {...register('pendingActionSlaHours.critical', { valueAsNumber: true })} />
          <Input label="High" type="number" {...register('pendingActionSlaHours.high', { valueAsNumber: true })} />
          <Input label="Medium" type="number" {...register('pendingActionSlaHours.medium', { valueAsNumber: true })} />
          <Input label="Low" type="number" {...register('pendingActionSlaHours.low', { valueAsNumber: true })} />
        </div>
        <Button type="submit" loading={mutation.isPending}>Save Settings</Button>
      </form>
    </div>
  );
}

// ─── GST Tab ──────────────────────────────────────────────────────────────────

function GstTab() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiGet<DistributorSettings>('/settings'),
  });

  const { register, handleSubmit, formState: { errors } } = useForm<GstCredentialsInput>({
    resolver: zodResolver(gstCredentialsSchema),
    values: settings?.gstCredentials ? {
      clientId: settings.gstCredentials.clientId,
      clientSecret: settings.gstCredentials.clientSecret,
      username: settings.gstCredentials.username,
      gstin: settings.gstCredentials.gstin,
    } : { clientId: '', clientSecret: '', username: '', gstin: '' },
  });

  const credentialsMutation = useMutation({
    mutationFn: (data: GstCredentialsInput) => apiPut('/settings/gst/credentials', data),
    onSuccess: () => { toast.success('GST credentials saved'); queryClient.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const modeMutation = useMutation({
    mutationFn: (mode: GstMode) => apiPut('/settings/gst/mode', { mode }),
    onSuccess: () => { toast.success('GST mode updated'); queryClient.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  if (isLoading) return <div className="flex justify-center py-20"><Loader size="lg" /></div>;

  const modeOptions = Object.values(GstMode).map((m) => ({ value: m, label: m.charAt(0).toUpperCase() + m.slice(1) }));

  return (
    <div className="max-w-2xl space-y-6">
      {/* GST Mode */}
      <div className="card p-6 space-y-4">
        <h3 className="font-semibold text-surface-900 dark:text-white">GST Mode</h3>
        <div className="flex items-center gap-3">
          <Badge variant={settings?.gstMode === GstMode.LIVE ? 'success' : settings?.gstMode === GstMode.SANDBOX ? 'warning' : 'neutral'}>
            Current: {settings?.gstMode}
          </Badge>
        </div>
        <div className="flex gap-2">
          {modeOptions.map((opt) => (
            <Button
              key={opt.value}
              variant={settings?.gstMode === opt.value ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => modeMutation.mutate(opt.value as GstMode)}
              loading={modeMutation.isPending}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {/* GST Credentials */}
      <div className="card p-6">
        <h3 className="font-semibold text-surface-900 dark:text-white mb-4">GST Credentials</h3>
        {settings?.gstCredentials?.isValid && (
          <Badge variant="success" className="mb-4">Credentials Valid</Badge>
        )}
        <form onSubmit={handleSubmit((data) => credentialsMutation.mutate(data))} className="space-y-4">
          <Input label="GSTIN" required error={errors.gstin?.message} {...register('gstin')} />
          <Input label="Client ID" required error={errors.clientId?.message} {...register('clientId')} />
          <Input label="Client Secret" type="password" required error={errors.clientSecret?.message} {...register('clientSecret')} />
          <Input label="Username" required error={errors.username?.message} {...register('username')} />
          <Button type="submit" loading={credentialsMutation.isPending}>Save Credentials</Button>
        </form>
      </div>
    </div>
  );
}

// ─── Prices Tab ──────────────────────────────────────────────────────────────

interface CylinderTypeItem {
  cylinderTypeId: string;
  typeName: string;
  capacity: number;
  unit: string;
  prices?: { priceId: string; price: number; effectiveDate: string }[];
}

interface PriceRecord {
  id: string;
  cylinderTypeId: string;
  price: number;
  effectiveDate: string;
  cylinderType?: { typeName: string };
}

interface EmptyPriceRecord {
  id: string;
  cylinderTypeId: string;
  emptyCylinderPrice: number;
  cylinderType?: { typeName: string };
}

function PricesTab() {
  const queryClient = useQueryClient();

  // Month/year selector state - default to current month
  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth()); // 0-indexed
  const [effectiveDate, setEffectiveDate] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  );

  // Price input state: { [cylinderTypeId]: price string }
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({});
  const [emptyPriceInputs, setEmptyPriceInputs] = useState<Record<string, string>>({});

  // Fetch cylinder types
  const { data: cylinderTypes, isLoading: typesLoading } = useQuery({
    queryKey: ['cylinder-types'],
    queryFn: () => apiGet<{ cylinderTypes: CylinderTypeItem[] }>('/cylinder-types'),
    select: (data) => data.cylinderTypes,
  });

  // Fetch current prices
  const { data: prices, isLoading: pricesLoading } = useQuery({
    queryKey: ['cylinder-prices'],
    queryFn: () => apiGet<PriceRecord[]>('/cylinder-types/prices/list'),
  });

  // Fetch empty prices
  const { data: emptyPrices, isLoading: emptyLoading } = useQuery({
    queryKey: ['cylinder-empty-prices'],
    queryFn: () => apiGet<EmptyPriceRecord[]>('/cylinder-types/empty-prices/list'),
  });

  // Save price mutation (one per cylinder type)
  const priceMutation = useMutation({
    mutationFn: (data: { cylinderTypeId: string; price: number; effectiveDate: string }) =>
      apiPost('/cylinder-types/prices', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cylinder-prices'] });
      queryClient.invalidateQueries({ queryKey: ['cylinder-types'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  // Save empty price mutation
  const emptyPriceMutation = useMutation({
    mutationFn: (data: { cylinderTypeId: string; emptyCylinderPrice: number }) =>
      apiPut('/cylinder-types/empty-prices', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cylinder-empty-prices'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  // Build a map of latest price per cylinder type
  const latestPriceMap: Record<string, number> = {};
  if (prices) {
    // prices are ordered by effectiveDate desc, so first per cylinderTypeId is the latest
    const seen = new Set<string>();
    for (const p of prices) {
      if (!seen.has(p.cylinderTypeId)) {
        latestPriceMap[p.cylinderTypeId] = p.price;
        seen.add(p.cylinderTypeId);
      }
    }
  }

  // Build a map of empty prices per cylinder type
  const emptyPriceMap: Record<string, number> = {};
  if (emptyPrices) {
    for (const ep of emptyPrices) {
      emptyPriceMap[ep.cylinderTypeId] = ep.emptyCylinderPrice;
    }
  }

  // Month options
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const yearOptions = [];
  for (let y = now.getFullYear() - 1; y <= now.getFullYear() + 1; y++) {
    yearOptions.push({ value: String(y), label: String(y) });
  }
  const monthOptions = monthNames.map((name, idx) => ({ value: String(idx), label: name }));

  const handleMonthYearChange = (month: number, year: number) => {
    setSelectedMonth(month);
    setSelectedYear(year);
    // Default effective date to 1st of that month
    setEffectiveDate(`${year}-${String(month + 1).padStart(2, '0')}-01`);
  };

  const handleSavePrices = async () => {
    const entries = Object.entries(priceInputs).filter(([, val]) => val !== '' && !isNaN(Number(val)) && Number(val) > 0);
    if (entries.length === 0) {
      toast.error('Enter at least one new price');
      return;
    }
    let successCount = 0;
    for (const [cylinderTypeId, priceStr] of entries) {
      try {
        await priceMutation.mutateAsync({ cylinderTypeId, price: Number(priceStr), effectiveDate });
        successCount++;
      } catch {
        // error already toasted by mutation
      }
    }
    if (successCount > 0) {
      toast.success(`${successCount} price(s) saved`);
      setPriceInputs({});
    }
  };

  const handleSaveEmptyPrices = async () => {
    const entries = Object.entries(emptyPriceInputs).filter(([, val]) => val !== '' && !isNaN(Number(val)) && Number(val) >= 0);
    if (entries.length === 0) {
      toast.error('Enter at least one empty cylinder price');
      return;
    }
    let successCount = 0;
    for (const [cylinderTypeId, priceStr] of entries) {
      try {
        await emptyPriceMutation.mutateAsync({ cylinderTypeId, emptyCylinderPrice: Number(priceStr) });
        successCount++;
      } catch {
        // error already toasted by mutation
      }
    }
    if (successCount > 0) {
      toast.success(`${successCount} empty price(s) saved`);
      setEmptyPriceInputs({});
    }
  };

  const isLoading = typesLoading || pricesLoading || emptyLoading;
  if (isLoading) return <div className="flex justify-center py-20"><Loader size="lg" /></div>;

  if (!cylinderTypes?.length) {
    return <EmptyState title="No cylinder types" description="Add cylinder types first before setting prices." />;
  }

  return (
    <div className="max-w-4xl space-y-8">
      {/* Section 1: Monthly Cylinder Prices */}
      <div className="card p-6 space-y-5">
        <h3 className="font-semibold text-surface-900 dark:text-white">Monthly Cylinder Prices</h3>

        {/* Month/Year selector and Effective Date */}
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="label">Month</label>
            <select
              className="input"
              value={selectedMonth}
              onChange={(e) => handleMonthYearChange(Number(e.target.value), selectedYear)}
            >
              {monthOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Year</label>
            <select
              className="input"
              value={selectedYear}
              onChange={(e) => handleMonthYearChange(selectedMonth, Number(e.target.value))}
            >
              {yearOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Effective From</label>
            <input
              type="date"
              className="input"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </div>
        </div>

        {/* Price Table */}
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Type Name</th>
                <th>Capacity</th>
                <th>Current Price</th>
                <th>New Price</th>
              </tr>
            </thead>
            <tbody>
              {cylinderTypes.map((ct) => (
                <tr key={ct.cylinderTypeId}>
                  <td className="font-medium text-surface-900 dark:text-white">{ct.typeName}</td>
                  <td>{ct.capacity} {ct.unit}</td>
                  <td>
                    {latestPriceMap[ct.cylinderTypeId] != null
                      ? `₹${latestPriceMap[ct.cylinderTypeId].toLocaleString('en-IN')}`
                      : <span className="text-surface-400">Not set</span>}
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="₹ New price"
                      className="input w-36"
                      value={priceInputs[ct.cylinderTypeId] ?? ''}
                      onChange={(e) => setPriceInputs((prev) => ({ ...prev, [ct.cylinderTypeId]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Button onClick={handleSavePrices} loading={priceMutation.isPending}>
          Save Prices
        </Button>
      </div>

      {/* Section 2: Empty Cylinder Prices */}
      <div className="card p-6 space-y-5">
        <h3 className="font-semibold text-surface-900 dark:text-white">Empty Cylinder Prices</h3>

        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Type Name</th>
                <th>Current Empty Price</th>
                <th>New Empty Price</th>
              </tr>
            </thead>
            <tbody>
              {cylinderTypes.map((ct) => (
                <tr key={ct.cylinderTypeId}>
                  <td className="font-medium text-surface-900 dark:text-white">{ct.typeName}</td>
                  <td>
                    {emptyPriceMap[ct.cylinderTypeId] != null
                      ? `₹${emptyPriceMap[ct.cylinderTypeId].toLocaleString('en-IN')}`
                      : <span className="text-surface-400">Not set</span>}
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="₹ Empty price"
                      className="input w-36"
                      value={emptyPriceInputs[ct.cylinderTypeId] ?? ''}
                      onChange={(e) => setEmptyPriceInputs((prev) => ({ ...prev, [ct.cylinderTypeId]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-surface-400">
          Empty cylinder cost is indicative and shown in customer ledger for accountability.
        </p>

        <Button onClick={handleSaveEmptyPrices} loading={emptyPriceMutation.isPending}>
          Save Empty Prices
        </Button>
      </div>
    </div>
  );
}

// ─── Thresholds Tab ──────────────────────────────────────────────────────────

function ThresholdsTab() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiGet<DistributorSettings>('/settings'),
  });

  // Also fetch cylinder types to pre-populate thresholds
  const { data: cylinderTypesData, isLoading: ctLoading } = useQuery({
    queryKey: ['cylinder-types'],
    queryFn: () => apiGet<{ cylinderTypes: Array<{ cylinderTypeId: string; typeName: string; capacity: number; isActive: boolean }> }>('/cylinder-types'),
  });

  const mutation = useMutation({
    mutationFn: (thresholds: CylinderThreshold[]) => apiPut('/cylinder-types/thresholds', { thresholds }),
    onSuccess: () => { toast.success('Thresholds saved'); queryClient.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const [editThresholds, setEditThresholds] = useState<CylinderThreshold[]>([]);
  const [initialized, setInitialized] = useState(false);

  const isLoading = settingsLoading || ctLoading;
  if (isLoading) return <div className="flex justify-center py-20"><Loader size="lg" /></div>;

  if (!initialized) {
    const existing = settings?.cylinderThresholds || [];
    const existingIds = new Set(existing.map(t => t.cylinderTypeId));
    const activeCts = (cylinderTypesData?.cylinderTypes || []).filter(ct => ct.isActive);

    // Merge existing thresholds with defaults for any cylinder types that don't have one yet
    const merged = [
      ...existing,
      ...activeCts
        .filter(ct => !existingIds.has(ct.cylinderTypeId))
        .map(ct => ({
          cylinderTypeId: ct.cylinderTypeId,
          cylinderTypeName: ct.typeName,
          warningLevel: 10,
          criticalLevel: 5,
          alertEnabled: true,
        })),
    ];
    setEditThresholds(merged);
    setInitialized(true);
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="card p-6">
        <h3 className="font-semibold text-surface-900 dark:text-white mb-4">Cylinder Thresholds</h3>
        {editThresholds.length === 0 ? (
          <EmptyState title="No thresholds configured" description="Thresholds will appear based on your cylinder types." />
        ) : (
          <div className="space-y-4">
            {editThresholds.map((t, index) => (
              <div key={t.cylinderTypeId} className="p-4 bg-surface-50 dark:bg-surface-800/50 rounded-xl">
                <div className="flex items-center justify-between mb-3">
                  <p className="font-medium text-surface-900 dark:text-white">{t.cylinderTypeName}</p>
                  <label className="flex items-center gap-2 text-xs text-surface-500">
                    <input
                      type="checkbox"
                      checked={t.alertEnabled}
                      onChange={(e) => {
                        const updated = [...editThresholds];
                        updated[index] = { ...updated[index], alertEnabled: e.target.checked };
                        setEditThresholds(updated);
                      }}
                      className="rounded"
                    />
                    Alerts Enabled
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">Warning Level</label>
                    <input
                      type="number"
                      value={t.warningLevel}
                      onChange={(e) => {
                        const updated = [...editThresholds];
                        updated[index] = { ...updated[index], warningLevel: Number(e.target.value) };
                        setEditThresholds(updated);
                      }}
                      className="input"
                    />
                  </div>
                  <div>
                    <label className="label">Critical Level</label>
                    <input
                      type="number"
                      value={t.criticalLevel}
                      onChange={(e) => {
                        const updated = [...editThresholds];
                        updated[index] = { ...updated[index], criticalLevel: Number(e.target.value) };
                        setEditThresholds(updated);
                      }}
                      className="input"
                    />
                  </div>
                </div>
              </div>
            ))}
            <Button onClick={() => mutation.mutate(editThresholds)} loading={mutation.isPending}>
              Save Thresholds
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Approvals Tab ──────────────────────────────────────────────────────────

function ApprovalsTab() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiGet<DistributorSettings>('/settings'),
  });

  const mutation = useMutation({
    mutationFn: (workflows: ApprovalWorkflowConfig[]) => apiPut('/settings/approval-workflows', { workflows }),
    onSuccess: () => { toast.success('Approvals saved'); queryClient.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const [editWorkflows, setEditWorkflows] = useState<ApprovalWorkflowConfig[]>([]);
  const [initialized, setInitialized] = useState(false);

  if (isLoading) return <div className="flex justify-center py-20"><Loader size="lg" /></div>;

  if (!initialized && settings?.approvalWorkflows) {
    setEditWorkflows(settings.approvalWorkflows);
    setInitialized(true);
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="card p-6">
        <h3 className="font-semibold text-surface-900 dark:text-white mb-4">Approval Workflows</h3>
        {editWorkflows.length === 0 ? (
          <EmptyState title="No approval workflows configured" />
        ) : (
          <div className="space-y-3">
            {editWorkflows.map((w, index) => (
              <div key={w.action} className="flex items-center justify-between p-4 bg-surface-50 dark:bg-surface-800/50 rounded-xl">
                <div>
                  <p className="font-medium text-surface-900 dark:text-white capitalize">{w.action.replace(/_/g, ' ')}</p>
                  <p className="text-xs text-surface-400 mt-0.5">Approvers: {w.approverRoles.join(', ')}</p>
                </div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={w.requiresApproval}
                    onChange={(e) => {
                      const updated = [...editWorkflows];
                      updated[index] = { ...updated[index], requiresApproval: e.target.checked };
                      setEditWorkflows(updated);
                    }}
                    className="rounded text-brand-500 focus:ring-brand-500/20"
                  />
                  <span className="text-sm text-surface-700 dark:text-surface-300">Required</span>
                </label>
              </div>
            ))}
            <Button onClick={() => mutation.mutate(editWorkflows)} loading={mutation.isPending}>
              Save Workflows
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Users Tab ──────────────────────────────────────────────────────────────

function UsersTab() {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);

  const { data: users, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => apiGet<{ users: User[] }>('/users'),
    select: (data) => data.users,
  });

  const deleteMutation = useMutation({
    mutationFn: (userId: string) => apiDelete(`/users/${userId}`),
    onSuccess: () => { toast.success('User deleted'); queryClient.invalidateQueries({ queryKey: ['users'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => { setEditUser(null); setFormOpen(true); }}>
          <HiOutlinePlus className="h-4 w-4" />Add User
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : !users?.length ? (
        <EmptyState title="No users" action={<Button onClick={() => setFormOpen(true)}>Add User</Button>} />
      ) : (
        <div className="table-container">
          <table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.userId}>
                  <td className="font-medium text-surface-900 dark:text-white">{user.firstName} {user.lastName}</td>
                  <td>{user.email}</td>
                  <td><Badge variant="info">{user.role.replace(/_/g, ' ')}</Badge></td>
                  <td><Badge variant={user.status === 'active' ? 'success' : 'neutral'}>{user.status}</Badge></td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button onClick={() => { setEditUser(user); setFormOpen(true); }} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-500">
                        <HiOutlinePencilSquare className="h-4 w-4" />
                      </button>
                      <button onClick={() => { if (confirm('Delete user?')) deleteMutation.mutate(user.userId); }} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-red-500">
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

      {formOpen && <UserFormModal open={formOpen} onClose={() => { setFormOpen(false); setEditUser(null); }} user={editUser} />}
    </div>
  );
}

function UserFormModal({ open, onClose, user }: { open: boolean; onClose: () => void; user: User | null }) {
  const queryClient = useQueryClient();
  const isEdit = !!user;

  const { register, handleSubmit, formState: { errors } } = useForm<CreateUserInput>({
    resolver: zodResolver(isEdit ? createUserSchema.partial().omit({ password: true }) : createUserSchema) as any,
    defaultValues: user
      ? { email: user.email, firstName: user.firstName, lastName: user.lastName, phone: user.phone || '', role: user.role }
      : { email: '', password: '', firstName: '', lastName: '', phone: '', role: UserRole.INVENTORY },
  });

  const mutation = useMutation({
    mutationFn: (data: CreateUserInput) =>
      isEdit ? apiPut(`/users/${user.userId}`, data) : apiPost('/users', data),
    onSuccess: () => { toast.success(isEdit ? 'User updated' : 'User created'); queryClient.invalidateQueries({ queryKey: ['users'] }); onClose(); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const roleOptions = [
    { value: UserRole.DISTRIBUTOR_ADMIN, label: 'Distributor Admin' },
    { value: UserRole.FINANCE, label: 'Finance' },
    { value: UserRole.INVENTORY, label: 'Inventory' },
    { value: UserRole.DRIVER, label: 'Driver' },
    { value: UserRole.CUSTOMER, label: 'Customer' },
  ];

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit User' : 'Add User'}>
      <form onSubmit={handleSubmit((data) => mutation.mutate(data as CreateUserInput))} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input label="First Name" required error={errors.firstName?.message} {...register('firstName')} />
          <Input label="Last Name" required error={errors.lastName?.message} {...register('lastName')} />
        </div>
        <Input label="Email" type="email" required error={errors.email?.message} {...register('email')} />
        {!isEdit && <Input label="Password" type="password" required error={errors.password?.message} {...register('password')} />}
        <Input label="Phone" {...register('phone')} />
        <Select label="Role" options={roleOptions} required error={errors.role?.message} {...register('role')} />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>{isEdit ? 'Update' : 'Create'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Licenses Tab ──────────────────────────────────────────────────────────

function LicensesTab() {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);

  const { data: licenses, isLoading } = useQuery({
    queryKey: ['licenses'],
    queryFn: () => apiGet<License[]>('/licenses'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/licenses/${id}`),
    onSuccess: () => { toast.success('License deleted'); queryClient.invalidateQueries({ queryKey: ['licenses'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setFormOpen(true)}>
          <HiOutlinePlus className="h-4 w-4" />Add License
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : !licenses?.length ? (
        <EmptyState title="No licenses" action={<Button onClick={() => setFormOpen(true)}>Add License</Button>} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {licenses.map((license) => (
            <div key={license.licenseId} className="card p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="font-medium text-surface-900 dark:text-white">{license.licenseName}</p>
                  <Badge variant="neutral" className="mt-1">{license.licenseType}</Badge>
                </div>
                <button onClick={() => { if (confirm('Delete?')) deleteMutation.mutate(license.licenseId); }} className="p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded">
                  <HiOutlineTrash className="h-4 w-4" />
                </button>
              </div>
              {license.expiryDate && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-surface-500">Expires:</span>
                  <span className={cn('font-medium', license.isExpired ? 'text-red-500' : license.daysUntilExpiry !== null && license.daysUntilExpiry < 30 ? 'text-amber-500' : 'text-surface-700 dark:text-surface-300')}>
                    {new Date(license.expiryDate).toLocaleDateString('en-IN')}
                    {license.isExpired && <Badge variant="danger" className="ml-2">Expired</Badge>}
                    {!license.isExpired && license.daysUntilExpiry !== null && license.daysUntilExpiry < 30 && (
                      <Badge variant="warning" className="ml-2">{license.daysUntilExpiry}d left</Badge>
                    )}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {formOpen && <LicenseFormModal open={formOpen} onClose={() => setFormOpen(false)} />}
    </div>
  );
}

function LicenseFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();

  const { register, handleSubmit, formState: { errors } } = useForm({
    defaultValues: { licenseType: LicenseType.CUSTOM as string, licenseName: '', expiryDate: '' },
  });

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiPost('/licenses', data),
    onSuccess: () => { toast.success('License added'); queryClient.invalidateQueries({ queryKey: ['licenses'] }); onClose(); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const typeOptions = Object.values(LicenseType).map((t) => ({ value: t, label: t.replace(/_/g, ' ') }));

  return (
    <Modal open={open} onClose={onClose} title="Add License">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Select label="License Type" options={typeOptions} {...register('licenseType')} />
        <Input label="License Name" required error={errors.licenseName?.message} {...register('licenseName', { required: 'License name is required' })} />
        <Input label="Expiry Date" type="date" {...register('expiryDate')} />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Add License</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Cylinder Config Tab ────────────────────────────────────────────────────

interface CatalogItem {
  id: string;
  providerCode: string;
  shortName: string;
  longName: string;
  weight: number;
  hsnCode: string;
  alreadyAdded: boolean;
}

function CylinderConfigTab() {
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const { data: catalogData, isLoading } = useQuery({
    queryKey: ['provider-catalog-for-distributor'],
    queryFn: () => apiGet<{ items: CatalogItem[]; providers: string[] }>('/provider-catalog/for-distributor'),
  });

  const { data: existingTypes } = useQuery({
    queryKey: ['cylinder-types'],
    queryFn: () => apiGet<{ cylinderTypes: Array<{ cylinderTypeId: string; typeName: string; capacity: number; isActive: boolean }> }>('/cylinder-types'),
  });

  const importMutation = useMutation({
    mutationFn: (catalogItemIds: string[]) => apiPost('/provider-catalog/import', { catalogItemIds }),
    onSuccess: (data: any) => {
      toast.success(`Imported ${data.imported} cylinder type(s)`);
      setSelectedIds([]);
      queryClient.invalidateQueries({ queryKey: ['provider-catalog-for-distributor'] });
      queryClient.invalidateQueries({ queryKey: ['cylinder-types'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const items = catalogData?.items || [];
  const providers = catalogData?.providers || [];
  const availableItems = items.filter(i => !i.alreadyAdded);
  const addedItems = items.filter(i => i.alreadyAdded);

  function toggleSelect(id: string) {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function selectAllAvailable() {
    setSelectedIds(availableItems.map(i => i.id));
  }

  if (isLoading) return <div className="flex justify-center py-10"><Loader size="lg" /></div>;

  if (providers.length === 0) {
    return (
      <EmptyState
        title="No providers configured"
        description="Ask your super admin to assign LPG providers (IOCL, HPCL, etc.) to your distributor before configuring cylinder types."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-surface-500 dark:text-surface-400">
            Your providers: {providers.map(p => (
              <span key={p} className="inline-block ml-1 px-2 py-0.5 rounded bg-surface-100 dark:bg-surface-700 text-xs font-medium">{p}</span>
            ))}
          </p>
        </div>
        {availableItems.length > 0 && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={selectAllAvailable}>Select All</Button>
            <Button
              onClick={() => importMutation.mutate(selectedIds)}
              loading={importMutation.isPending}
              disabled={selectedIds.length === 0}
            >
              <HiOutlinePlus className="h-4 w-4" />
              Import Selected ({selectedIds.length})
            </Button>
          </div>
        )}
      </div>

      {/* Available from catalog */}
      {availableItems.length > 0 && (
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-white mb-3">Available from Provider Catalog</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {availableItems.map(item => (
              <label
                key={item.id}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  selectedIds.includes(item.id)
                    ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                    : 'border-surface-200 dark:border-surface-700 hover:border-surface-300 dark:hover:border-surface-600'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(item.id)}
                  onChange={() => toggleSelect(item.id)}
                  className="rounded border-surface-300 text-brand-600 focus:ring-brand-500"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-surface-900 dark:text-white">{item.longName}</p>
                  <p className="text-xs text-surface-500">{item.providerCode} &middot; {item.weight} KG &middot; HSN: {item.hsnCode}</p>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Already configured */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-surface-900 dark:text-white mb-3">
          Your Cylinder Types ({(existingTypes?.cylinderTypes || []).length})
        </h3>
        {!(existingTypes?.cylinderTypes?.length) ? (
          <p className="text-sm text-surface-500">No cylinder types configured yet. Import from the provider catalog above.</p>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Type</th><th>Capacity</th><th>Status</th></tr></thead>
              <tbody>
                {existingTypes.cylinderTypes.map(ct => (
                  <tr key={ct.cylinderTypeId}>
                    <td className="font-medium text-surface-900 dark:text-white">{ct.typeName}</td>
                    <td>{ct.capacity} KG</td>
                    <td><Badge variant={ct.isActive ? 'success' : 'danger'}>{ct.isActive ? 'Active' : 'Inactive'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {addedItems.length > 0 && (
        <div className="card p-5 bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800">
          <h3 className="text-sm font-semibold text-green-700 dark:text-green-300 mb-2">Already Imported from Catalog</h3>
          <div className="flex flex-wrap gap-2">
            {addedItems.map(item => (
              <span key={item.id} className="text-xs px-2 py-1 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                {item.providerCode} {item.shortName}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Subscription Tab (Distributor Admin) ───────────────────────────────────

function SubscriptionTab() {
  const fmt = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);

  const { data: billingData, isLoading } = useQuery({
    queryKey: ['my-billing-cycles'],
    queryFn: () => apiGet<{ cycles: Array<{
      cycleId: string; periodType: string; periodStartDate: string; periodEndDate: string;
      totalAmountExclGst: number; totalGstAmount: number; totalAmountInclGst: number;
      billingStatus: string; dueDate: string | null;
      items: Array<{ itemId: string; itemType: string; description: string; quantity: number; unitPriceExclGst: number; lineTotalInclGst: number }>;
    }> }>('/billing/cycles'),
  });

  const { data: seatData } = useQuery({
    queryKey: ['my-seat-limits'],
    queryFn: () => apiGet<{ plan: string; limits: Record<string, { allowed: number; used: number; extraPrice: number }> | null; gstApi: { included: number; overagePrice: number }; customerPortalPrice: number }>('/pricing/seat-limits'),
  });

  const handleDownload = async (cycleId: string) => {
    try {
      const res = await api.get(`/pricing/billing-invoice/${cycleId}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = `gaslink-invoice-${cycleId.slice(-6)}.pdf`; a.click();
      window.URL.revokeObjectURL(url);
    } catch { toast.error('Failed to download invoice'); }
  };

  if (isLoading) return <div className="flex justify-center py-10"><Loader size="lg" /></div>;

  const cycles = billingData?.cycles || [];
  const currentCycle = cycles[0]; // Most recent
  const plan = seatData?.plan;
  const limits = seatData?.limits || {};
  const totalPaid = cycles.filter(c => c.billingStatus === 'paid_billing').reduce((s, c) => s + c.totalAmountInclGst, 0);
  const totalPending = cycles.filter(c => c.billingStatus !== 'paid_billing').reduce((s, c) => s + c.totalAmountInclGst, 0);

  return (
    <div className="space-y-6">
      {/* Plan Overview */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-surface-900 dark:text-white mb-4">Your Subscription</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-surface-500">Current Plan</p>
            <p className="text-lg font-bold text-brand-600 dark:text-brand-400 capitalize">{plan || 'Not assigned'}</p>
          </div>
          <div>
            <p className="text-xs text-surface-500">Current Period</p>
            <p className="text-sm font-medium text-surface-900 dark:text-white">
              {currentCycle ? `${new Date(currentCycle.periodStartDate).toLocaleDateString('en-IN')} — ${new Date(currentCycle.periodEndDate).toLocaleDateString('en-IN')}` : 'No billing cycle'}
            </p>
          </div>
          <div>
            <p className="text-xs text-surface-500">Total Paid</p>
            <p className="text-lg font-bold text-green-600">{fmt(totalPaid)}</p>
          </div>
          <div>
            <p className="text-xs text-surface-500">Pending Amount</p>
            <p className={`text-lg font-bold ${totalPending > 0 ? 'text-red-500' : 'text-green-500'}`}>{fmt(totalPending)}</p>
          </div>
        </div>
      </div>

      {/* Seat Usage */}
      {Object.keys(limits).length > 0 && (
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-white mb-3">Seat Usage</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {Object.entries(limits).map(([role, data]) => (
              <div key={role} className="rounded-lg border border-surface-200 dark:border-surface-700 p-3">
                <p className="text-xs text-surface-500 capitalize">{role.replace('_', ' ')}</p>
                <div className="flex items-end gap-1 mt-1">
                  <span className="text-xl font-bold text-surface-900 dark:text-white">{data.used}</span>
                  <span className="text-sm text-surface-400 mb-0.5">/ {data.allowed}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-surface-200 dark:bg-surface-700 overflow-hidden">
                  <div className={`h-full rounded-full ${data.used >= data.allowed ? 'bg-red-500' : 'bg-brand-500'}`}
                    style={{ width: `${Math.min(100, data.allowed > 0 ? (data.used / data.allowed) * 100 : 0)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* GST API Allocation */}
      {seatData?.gstApi && (
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-white mb-3">GST API Allocation</h3>
          <div className="grid grid-cols-3 gap-4">
            <div><p className="text-xs text-surface-500">Included Calls/mo</p><p className="text-lg font-bold text-surface-900 dark:text-white">{seatData.gstApi.included.toLocaleString()}</p></div>
            <div><p className="text-xs text-surface-500">Overage Price</p><p className="text-lg font-bold text-surface-900 dark:text-white">{fmt(seatData.gstApi.overagePrice)}/call</p></div>
            <div><p className="text-xs text-surface-500">Customer Portal</p><p className="text-lg font-bold text-surface-900 dark:text-white">{fmt(seatData.customerPortalPrice)}/user/mo</p></div>
          </div>
        </div>
      )}

      {/* Billing History */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-surface-900 dark:text-white mb-3">Billing History</h3>
        {cycles.length === 0 ? (
          <p className="text-sm text-surface-500">No billing history yet.</p>
        ) : (
          <div className="space-y-3">
            {cycles.map(cycle => (
              <div key={cycle.cycleId} className="rounded-lg border border-surface-200 dark:border-surface-700 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="neutral">{cycle.periodType.replace('_', ' ')}</Badge>
                    <span className="text-sm text-surface-700 dark:text-surface-300">
                      {new Date(cycle.periodStartDate).toLocaleDateString('en-IN')} — {new Date(cycle.periodEndDate).toLocaleDateString('en-IN')}
                    </span>
                    <Badge variant={cycle.billingStatus === 'paid_billing' ? 'success' : cycle.billingStatus === 'overdue_billing' ? 'danger' : 'warning'}>
                      {cycle.billingStatus.replace(/_/g, ' ')}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold text-surface-900 dark:text-white">{fmt(cycle.totalAmountInclGst)}</span>
                    <button onClick={() => handleDownload(cycle.cycleId)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500" title="Download Invoice">
                      <HiOutlineDocumentArrowDown className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {/* Line items */}
                <div className="table-container">
                  <table className="table text-xs">
                    <thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th><th className="text-right">Total (incl GST)</th></tr></thead>
                    <tbody>
                      {cycle.items.map(item => (
                        <tr key={item.itemId}>
                          <td className="text-surface-700 dark:text-surface-300">{item.description}</td>
                          <td>{item.quantity}</td>
                          <td>{fmt(item.unitPriceExclGst)}</td>
                          <td className="text-right font-medium">{fmt(item.lineTotalInclGst)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-surface-200 dark:border-surface-700">
                        <td colSpan={3} className="text-right font-medium text-surface-600 dark:text-surface-400">Subtotal (excl GST)</td>
                        <td className="text-right font-medium">{fmt(cycle.totalAmountExclGst)}</td>
                      </tr>
                      <tr>
                        <td colSpan={3} className="text-right text-surface-500">GST (18%)</td>
                        <td className="text-right">{fmt(cycle.totalGstAmount)}</td>
                      </tr>
                      <tr>
                        <td colSpan={3} className="text-right font-bold text-surface-900 dark:text-white">Total</td>
                        <td className="text-right font-bold text-brand-600 dark:text-brand-400">{fmt(cycle.totalAmountInclGst)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {cycle.dueDate && (
                  <p className="text-xs text-surface-400 mt-2">Due: {new Date(cycle.dueDate).toLocaleDateString('en-IN')}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
