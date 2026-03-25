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
  HiOutlineCreditCard,
  HiOutlineEye,
  HiOutlineCurrencyRupee,
} from 'react-icons/hi2';
import {
  type DistributorSettings,
  type CylinderThreshold,
  type ApprovalWorkflowConfig,
  type User,
  type License,
  type BillingCycle,
  BillingStatus,
  GstMode,
  UserRole,
  LicenseType,
  gstCredentialsSchema,
  type GstCredentialsInput,
  createUserSchema,
  type CreateUserInput,
} from '@gaslink/shared';
import { apiGet, apiPost, apiPut, apiDelete, getErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';

export default function SettingsPage() {
  const { user } = useAuthStore();
  const showBilling = user?.role === UserRole.SUPER_ADMIN || user?.role === UserRole.DISTRIBUTOR_ADMIN;
  const showPrices = user?.role === UserRole.SUPER_ADMIN || user?.role === UserRole.DISTRIBUTOR_ADMIN;
  const [tab, setTab] = useState<'general' | 'gst' | 'prices' | 'thresholds' | 'approvals' | 'users' | 'licenses' | 'billing'>('general');

  const tabs = [
    { key: 'general' as const, label: 'General', icon: HiOutlineCog6Tooth },
    { key: 'gst' as const, label: 'GST', icon: HiOutlineShieldCheck },
    ...(showPrices ? [{ key: 'prices' as const, label: 'Cylinder Prices', icon: HiOutlineCurrencyRupee }] : []),
    { key: 'thresholds' as const, label: 'Thresholds', icon: HiOutlineExclamationTriangle },
    { key: 'approvals' as const, label: 'Approvals', icon: HiOutlineCheckCircle },
    { key: 'users' as const, label: 'Users', icon: HiOutlineUsers },
    { key: 'licenses' as const, label: 'Licenses', icon: HiOutlineDocumentText },
    ...(showBilling ? [{ key: 'billing' as const, label: 'Billing', icon: HiOutlineCreditCard }] : []),
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
      {tab === 'general' && <GeneralTab />}
      {tab === 'gst' && <GstTab />}
      {tab === 'prices' && <PricesTab />}
      {tab === 'thresholds' && <ThresholdsTab />}
      {tab === 'approvals' && <ApprovalsTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'licenses' && <LicensesTab />}
      {tab === 'billing' && <BillingTab />}
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
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiGet<DistributorSettings>('/settings'),
  });

  const mutation = useMutation({
    mutationFn: (thresholds: CylinderThreshold[]) => apiPut('/cylinder-types/thresholds', { thresholds }),
    onSuccess: () => { toast.success('Thresholds saved'); queryClient.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const [editThresholds, setEditThresholds] = useState<CylinderThreshold[]>([]);
  const [initialized, setInitialized] = useState(false);

  if (isLoading) return <div className="flex justify-center py-20"><Loader size="lg" /></div>;

  if (!initialized && settings?.cylinderThresholds) {
    setEditThresholds(settings.cylinderThresholds);
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

// ─── Billing Tab ──────────────────────────────────────────────────────────────

const BILLING_STATUS_VARIANTS: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  [BillingStatus.PENDING_GENERATION]: 'neutral',
  [BillingStatus.INVOICE_GENERATED]: 'info',
  [BillingStatus.PENDING_PAYMENT]: 'warning',
  [BillingStatus.PAID]: 'success',
  [BillingStatus.OVERDUE]: 'danger',
  [BillingStatus.SUSPENDED]: 'danger',
};

function formatBillingCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
}

function BillingTab() {
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-surface-500 dark:text-surface-400">
          {isSuperAdmin ? 'Manage GasLink billing for all distributors' : 'View your billing status'}
        </p>
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
                  <td>{formatBillingCurrency(cycle.totalAmountExclGst)}</td>
                  <td>{formatBillingCurrency(cycle.totalGstAmount)}</td>
                  <td className="font-medium">{formatBillingCurrency(cycle.totalAmountInclGst)}</td>
                  <td>{cycle.dueDate ? new Date(cycle.dueDate).toLocaleDateString('en-IN') : '-'}</td>
                  <td><Badge variant={BILLING_STATUS_VARIANTS[cycle.billingStatus] || 'neutral'}>{cycle.billingStatus.replace(/_/g, ' ')}</Badge></td>
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
              <div><p className="text-xs text-surface-400">Status</p><Badge variant={BILLING_STATUS_VARIANTS[viewCycle.billingStatus] || 'neutral'}>{viewCycle.billingStatus}</Badge></div>
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
                        <td>{formatBillingCurrency(item.unitPriceExclGst)}</td>
                        <td>{item.gstRate}%</td>
                        <td>{formatBillingCurrency(item.discountAmount)}</td>
                        <td className="font-medium">{formatBillingCurrency(item.lineTotalInclGst)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="grid grid-cols-3 gap-4 pt-4 border-t border-surface-200 dark:border-surface-700">
              <div><p className="text-xs text-surface-400">Subtotal</p><p className="font-medium">{formatBillingCurrency(viewCycle.totalAmountExclGst)}</p></div>
              <div><p className="text-xs text-surface-400">GST</p><p className="font-medium">{formatBillingCurrency(viewCycle.totalGstAmount)}</p></div>
              <div><p className="text-xs text-surface-400">Total</p><p className="font-bold text-lg">{formatBillingCurrency(viewCycle.totalAmountInclGst)}</p></div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
