import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, type Resolver } from 'react-hook-form';
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
  HiOutlineClipboardDocument,
  HiOutlineChatBubbleLeftRight,
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
import { useAuthStore, selectDistributorId } from '@/stores/authStore';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';
import { OnboardingTab } from '@/components/OnboardingTab';

type SettingsTabKey =
  | 'onboarding'
  | 'general'
  | 'subscription'
  | 'gst'
  | 'cylinders'
  | 'prices'
  | 'thresholds'
  | 'approvals'
  | 'users'
  | 'licenses';

export default function SettingsPage() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === UserRole.SUPER_ADMIN || user?.role === UserRole.DISTRIBUTOR_ADMIN;
  // WI-080: inventory + finance get full edit access to config tabs only
  // (Cylinder Types, Cylinder Prices, Thresholds, Licenses). Admin-only
  // tabs (Onboarding, General, Subscription, GST, Approvals, Users) stay
  // hidden from them — the backend enforces the same split.
  const isOps = user?.role === UserRole.INVENTORY || user?.role === UserRole.FINANCE;
  const showPrices = isAdmin;
  const showOnboarding = isAdmin;

  const tabs = [
    ...(showOnboarding ? [{ key: 'onboarding' as const, label: 'Onboarding', icon: HiOutlineCheckCircle }] : []),
    ...(isAdmin ? [{ key: 'general' as const, label: 'General', icon: HiOutlineCog6Tooth }] : []),
    ...(showPrices ? [{ key: 'subscription' as const, label: 'Subscription', icon: HiOutlineCurrencyRupee }] : []),
    ...(isAdmin ? [{ key: 'gst' as const, label: 'GST', icon: HiOutlineShieldCheck }] : []),
    ...(isAdmin || isOps ? [{ key: 'cylinders' as const, label: 'Cylinder Types', icon: HiOutlineCube }] : []),
    ...(isAdmin || isOps ? [{ key: 'prices' as const, label: 'Cylinder Prices', icon: HiOutlineCurrencyRupee }] : []),
    ...(isAdmin || isOps ? [{ key: 'thresholds' as const, label: 'Thresholds', icon: HiOutlineExclamationTriangle }] : []),
    ...(isAdmin ? [{ key: 'approvals' as const, label: 'Approvals', icon: HiOutlineCheckCircle }] : []),
    ...(isAdmin ? [{ key: 'users' as const, label: 'Users', icon: HiOutlineUsers }] : []),
    ...(isAdmin || isOps ? [{ key: 'licenses' as const, label: 'Licenses', icon: HiOutlineDocumentText }] : []),
  ];

  const allowedTabs = tabs.map((t) => t.key);
  const rawTab = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') : null;
  const initialTab = rawTab as SettingsTabKey | null;
  // Admin/super-admin land on Onboarding (the setup checklist) by default;
  // ops roles (inventory/finance) don't see Onboarding, so they default to
  // Cylinder Types. A ?tab= query param still overrides either default.
  const defaultTab = isOps ? 'cylinders' : 'onboarding';
  const [tab, setTab] = useState<SettingsTabKey>(
    initialTab && allowedTabs.includes(initialTab) ? initialTab : defaultTab,
  );

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
  const distributorId = useAuthStore(selectDistributorId);
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings', distributorId],
    queryFn: () => apiGet<DistributorSettings>('/settings'),
    enabled: !!distributorId,
  });

  const { register, handleSubmit } = useForm({
    values: { pendingActionSlaHours: settings?.pendingActionSlaHours ?? {} },
  });

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiPut('/settings/general', { value: data }),
    onSuccess: () => { toast.success('Settings saved'); queryClient.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  // WI-108: structured invoice/order numbering tenant code.
  const [docCodeInput, setDocCodeInput] = useState<string | null>(null);
  const docCodeValue = docCodeInput ?? settings?.docCode ?? '';
  const docCodeMutation = useMutation({
    mutationFn: (code: string) => apiPut('/settings/doc-code', { docCode: code }),
    onSuccess: () => { toast.success('Invoice code saved'); queryClient.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });
  const handleSaveDocCode = () => {
    const code = docCodeValue.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) { toast.error('Invoice code must be exactly 3 letters (A–Z)'); return; }
    // Warn before changing an already-set code — it breaks the sequence.
    if (settings?.docCode && settings.docCode !== code &&
        !window.confirm('Changing this code will break your invoice sequence. Are you sure?')) {
      return;
    }
    docCodeMutation.mutate(code);
  };

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

      {/* WI-108: structured invoice/order numbering */}
      <div className="border-t border-surface-200 dark:border-surface-700 pt-6 space-y-3">
        <h3 className="font-semibold text-surface-900 dark:text-white">Invoice Code</h3>
        <p className="text-sm text-surface-500 dark:text-surface-400">
          Once set, this code appears in all invoice and order numbers
          (e.g. <span className="font-mono">ISHD2526000123</span>). Setting this activates structured numbering.
        </p>
        <div className="flex items-end gap-3">
          <Input
            label="Invoice Code (3 letters)"
            value={docCodeValue}
            maxLength={3}
            placeholder="SHD"
            onChange={(e) => setDocCodeInput(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3))}
          />
          <Button type="button" onClick={handleSaveDocCode} loading={docCodeMutation.isPending}>Save Code</Button>
        </div>
      </div>
    </div>
  );
}

// ─── GST Tab ──────────────────────────────────────────────────────────────────

// WI-042: shape returned by GET /api/settings/gst/credentials (one row
// per scope, masked: no clientSecret / password).
type GstCredentialRow = {
  id: string;
  clientId: string;
  username: string;
  gstin: string;
  email: string | null;
  scope: 'einvoice' | 'ewaybill';
  isValid: boolean;
  lastValidated: string | null;
};

function GstTab() {
  const queryClient = useQueryClient();
  const distributorId = useAuthStore(selectDistributorId);
  const { user } = useAuthStore();
  // Group A Step 7: only super_admin can edit GST mode and credentials now.
  // distributor_admin sees the current state as read-only and a hint to
  // contact the platform admin.
  const canEditGst = user?.role === UserRole.SUPER_ADMIN;
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings', distributorId],
    queryFn: () => apiGet<DistributorSettings>('/settings'),
    enabled: !!distributorId,
  });

  // Scoped credentials list — drives the two credential cards.
  const { data: credentials } = useQuery({
    queryKey: ['gst-credentials', distributorId],
    queryFn: () =>
      apiGet<GstCredentialRow[] | GstCredentialRow | null>('/settings/gst/credentials'),
    enabled: !!distributorId,
  });

  // Normalize: backend returns either an array (all scopes) or null.
  const credList: GstCredentialRow[] = Array.isArray(credentials)
    ? credentials
    : credentials
      ? [credentials]
      : [];
  const credByScope = new Map(credList.map((c) => [c.scope, c]));

  const modeMutation = useMutation({
    mutationFn: (mode: GstMode) => apiPut('/settings/gst/mode', { mode }),
    onSuccess: () => { toast.success('GST mode updated'); queryClient.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const [updateScope, setUpdateScope] = useState<'einvoice' | 'ewaybill' | null>(null);

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
        {canEditGst ? (
          <>
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
            <p className="text-xs text-surface-500 dark:text-surface-400">
              Direct mode toggle is for super-admin emergency use. Use the
              dedicated GST Activation screen on the distributor detail page
              for the standard activation/rotation flow.
            </p>
          </>
        ) : (
          <p className="text-sm text-surface-600 dark:text-surface-400">
            GST settings are managed by your platform administrator. Contact
            support if you need to change your GST mode or credentials.
          </p>
        )}
      </div>

      {/* GST API Credentials — one card per scope (WI-042). */}
      <div className="card p-6 space-y-4">
        <h3 className="font-semibold text-surface-900 dark:text-white">GST API Credentials</h3>
        <GstCredentialCard
          scope="einvoice"
          label="e-Invoice Credentials"
          row={credByScope.get('einvoice') ?? null}
          onUpdate={() => setUpdateScope('einvoice')}
          canEdit={canEditGst}
        />
        <GstCredentialCard
          scope="ewaybill"
          label="e-Way Bill Credentials"
          row={credByScope.get('ewaybill') ?? null}
          onUpdate={() => setUpdateScope('ewaybill')}
          canEdit={canEditGst}
        />
      </div>

      {updateScope && (
        <GstCredentialUpdateModal
          scope={updateScope}
          existing={credByScope.get(updateScope) ?? null}
          onClose={() => setUpdateScope(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['gst-credentials'] });
            queryClient.invalidateQueries({ queryKey: ['settings'] });
            setUpdateScope(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * WI-054: Test Connection response shape — both halves of the probe
 * (WhiteBooks auth + NIC reachability) are surfaced as distinct
 * indicators so admins can see WHICH hop is broken. Today's WhiteBooks
 * "email not registered" outage renders authenticated=false; the
 * 2026-05-15 NIC 5002 outage renders authenticated=true / nicReachable=false.
 */
type TestConnectionResult = {
  scope: 'einvoice' | 'ewaybill';
  authenticated: boolean;
  nicReachable: boolean;
  message: string;
  authError?: string;
  nicError?: string;
};

function GstCredentialCard({
  scope, label, row, onUpdate, canEdit,
}: {
  scope: 'einvoice' | 'ewaybill';
  label: string;
  row: GstCredentialRow | null;
  onUpdate: () => void;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const testMutation = useMutation({
    mutationFn: () => apiPost<TestConnectionResult>(`/settings/gst/credentials/${scope}/test`),
    onSuccess: (result) => {
      setTestResult(result);
      // Only toast for the all-green case; UI panel surfaces the mixed/red states inline.
      if (result.authenticated && result.nicReachable) {
        toast.success(result.message || 'Connection validated');
      }
      queryClient.invalidateQueries({ queryKey: ['gst-credentials'] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  // WI-089: the persisted `row.isValid` flag is stamped true on every
  // successful WhiteBooks *auth* (getAuthToken), independent of NIC health.
  // It must NOT be flipped on a transient NIC outage — gstinLookup and the
  // dispatch credential-resolution path both require isValid:true, and the
  // 2026-05-21 probe proved the NIC GSTNDETAILS session can be dead for 10+
  // minutes while auth + IRN GENERATE stay perfectly healthy. So we keep
  // isValid as "credentials authenticate" and instead make the badge stop
  // implying end-to-end health: when an in-session Test Connection shows the
  // NIC hop down, downgrade the badge to amber so it agrees with the red ×
  // row below instead of showing a misleading green "Valid".
  const nicDown = !!testResult && testResult.authenticated && !testResult.nicReachable;

  return (
    <div className="rounded-lg border border-surface-200 dark:border-surface-700 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="font-medium text-surface-900 dark:text-white">{label}</div>
          {row ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs text-surface-500 dark:text-surface-400">
              <div><span className="text-surface-400">Client ID:</span> <span className="font-mono">{row.clientId}</span></div>
              <div><span className="text-surface-400">Username:</span> {row.username}</div>
              <div><span className="text-surface-400">GSTIN:</span> <span className="font-mono">{row.gstin}</span></div>
              <div><span className="text-surface-400">Email:</span> {row.email ?? '—'}</div>
              <div className="col-span-full flex items-center gap-2">
                <span
                  className={cn(
                    'inline-flex items-center gap-1 text-xs',
                    row.isValid && !nicDown
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-amber-600 dark:text-amber-400',
                  )}
                >
                  <span className="inline-block h-2 w-2 rounded-full bg-current" />
                  {!row.isValid
                    ? 'Not validated'
                    : nicDown
                      ? 'Credentials valid · NIC unreachable'
                      : 'Credentials valid'}
                </span>
                {row.lastValidated && (
                  <span className="text-surface-400">
                    · last validated {new Date(row.lastValidated).toLocaleDateString('en-IN')}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-surface-500 dark:text-surface-400">
              {canEdit
                ? `Not configured. Click Update Credentials to enter the WhiteBooks ${scope} credentials.`
                : `Not configured. Contact your platform administrator to set up ${scope === 'einvoice' ? 'e-Invoice' : 'e-Way Bill'} credentials.`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {row && canEdit && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => testMutation.mutate()}
              loading={testMutation.isPending}
            >
              Test Connection
            </Button>
          )}
          {canEdit && (
            <Button size="sm" onClick={onUpdate}>Update Credentials</Button>
          )}
        </div>
      </div>

      {/* WI-054: Two-row Test Connection result panel. Renders when the
          mutation has completed at least once. Each row is independently
          green/red so the user can tell which hop failed. */}
      {testResult && (
        <div className="mt-3 rounded-md border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 p-3 text-xs space-y-1">
          <TestStatusRow
            label="WhiteBooks"
            ok={testResult.authenticated}
            okText="Connected"
            failText={testResult.authError || 'Authentication failed'}
          />
          <TestStatusRow
            label="NIC Portal"
            ok={testResult.nicReachable}
            okText={scope === 'ewaybill' ? 'Reachable (via EWB auth)' : 'Reachable'}
            failText={
              testResult.authenticated
                ? testResult.nicError || 'NIC not responding'
                : '— (skipped, auth failed first)'
            }
          />
        </div>
      )}
    </div>
  );
}

function TestStatusRow({
  label, ok, okText, failText,
}: { label: string; ok: boolean; okText: string; failText: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 text-surface-500 dark:text-surface-400">{label}:</span>
      <span
        className={cn(
          'inline-flex items-center gap-1',
          ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400',
        )}
      >
        <span aria-hidden>{ok ? '✅' : '❌'}</span>
        <span>{ok ? okText : failText}</span>
      </span>
    </div>
  );
}

function GstCredentialUpdateModal({
  scope, existing, onClose, onSaved,
}: {
  scope: 'einvoice' | 'ewaybill';
  existing: GstCredentialRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<GstCredentialsInput>({
    resolver: zodResolver(gstCredentialsSchema),
    defaultValues: existing
      ? {
          clientId: existing.clientId,
          clientSecret: '',
          username: existing.username,
          password: '',
          gstin: existing.gstin,
          email: existing.email ?? '',
        }
      : { clientId: '', clientSecret: '', username: '', password: '', gstin: '', email: '' },
  });
  const mutation = useMutation({
    mutationFn: (data: GstCredentialsInput) =>
      apiPut(`/settings/gst/credentials/${scope}`, { ...data, scope }),
    onSuccess: () => { toast.success('Credentials validated ✓'); onSaved(); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const title = scope === 'einvoice' ? 'Update e-Invoice Credentials' : 'Update e-Way Bill Credentials';
  return (
    <Modal open onClose={onClose} title={title} size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <p className="text-sm text-surface-500 dark:text-surface-400">
          Credentials are tested against WhiteBooks before being saved. If
          authentication fails the form stays open with the NIC error message.
        </p>
        <Input label="GSTIN" required error={errors.gstin?.message} {...register('gstin')} />
        <Input label="Client ID" required error={errors.clientId?.message} {...register('clientId')} />
        <Input label="Client Secret" type="password" required error={errors.clientSecret?.message} {...register('clientSecret')} />
        <Input label="Username" required error={errors.username?.message} {...register('username')} />
        <Input label="Password" type="password" error={errors.password?.message} {...register('password')} />
        <Input label="Email" type="email" error={errors.email?.message} {...register('email')} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Test &amp; Save</Button>
        </div>
      </form>
    </Modal>
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
  const distributorId = useAuthStore(selectDistributorId);

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
    queryKey: ['cylinder-types', distributorId],
    queryFn: () => apiGet<{ cylinderTypes: CylinderTypeItem[] }>('/cylinder-types'),
    select: (data) => data.cylinderTypes,
    enabled: !!distributorId,
  });

  // Fetch current prices
  const { data: prices, isLoading: pricesLoading } = useQuery({
    queryKey: ['cylinder-prices', distributorId],
    queryFn: () => apiGet<PriceRecord[]>('/cylinder-types/prices/list'),
    enabled: !!distributorId,
  });

  // Fetch empty prices
  const { data: emptyPrices, isLoading: emptyLoading } = useQuery({
    queryKey: ['cylinder-empty-prices', distributorId],
    queryFn: () => apiGet<EmptyPriceRecord[]>('/cylinder-types/empty-prices/list'),
    enabled: !!distributorId,
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

      {/* Section 2: Empty Deposit Prices (WI-2 — renamed from "Empty Cylinder
          Prices"; same underlying empty_cylinder_prices store. Drives Report
          Mismatch unit-amount calculation downstream.) */}
      <div className="card p-6 space-y-5">
        <h3 className="font-semibold text-surface-900 dark:text-white">Empty Deposit Prices</h3>

        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Type Name</th>
                <th>Current Empty Deposit Price</th>
                <th>New Empty Deposit Price (₹)</th>
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
                      placeholder="₹ Empty deposit price"
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
          The empty deposit price is the value of one empty cylinder. Used in
          customer ledgers and in the Report Mismatch unit-amount calculation
          (Inventory → Vehicle Return).
        </p>

        <Button onClick={handleSaveEmptyPrices} loading={emptyPriceMutation.isPending}>
          Save Empty Deposit Prices
        </Button>
      </div>
    </div>
  );
}

// ─── Thresholds Tab ──────────────────────────────────────────────────────────

function ThresholdsTab() {
  const queryClient = useQueryClient();
  const distributorId = useAuthStore(selectDistributorId);
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['settings', distributorId],
    queryFn: () => apiGet<DistributorSettings>('/settings'),
    enabled: !!distributorId,
  });

  // Also fetch cylinder types to pre-populate thresholds
  const { data: cylinderTypesData, isLoading: ctLoading } = useQuery({
    queryKey: ['cylinder-types', distributorId],
    queryFn: () => apiGet<{ cylinderTypes: Array<{ cylinderTypeId: string; typeName: string; capacity: number; isActive: boolean }> }>('/cylinder-types'),
    enabled: !!distributorId,
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
  const distributorId = useAuthStore(selectDistributorId);
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings', distributorId],
    queryFn: () => apiGet<DistributorSettings>('/settings'),
    enabled: !!distributorId,
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

// Post-creation handoff payload — only set on a successful CREATE. The
// modal switches to the credentials view so the admin can copy the temp
// password or fire it to the user over WhatsApp. The tempPassword string
// is held in component memory ONLY; it is never written to localStorage,
// never re-fetched, and disappears the moment the modal closes.
type CreatedCreds = {
  name: string;
  email: string;
  phone: string;
  tempPassword: string;
};

function UserFormModal({ open, onClose, user }: { open: boolean; onClose: () => void; user: User | null }) {
  const queryClient = useQueryClient();
  const isEdit = !!user;
  const [createdCreds, setCreatedCreds] = useState<CreatedCreds | null>(null);

  const { register, handleSubmit, getValues, formState: { errors } } = useForm<CreateUserInput>({
    resolver: zodResolver(isEdit ? createUserSchema.partial().omit({ password: true }) : createUserSchema) as unknown as Resolver<CreateUserInput>,
    defaultValues: user
      ? { email: user.email, firstName: user.firstName, lastName: user.lastName, phone: user.phone || '', role: user.role }
      : { email: '', password: '', firstName: '', lastName: '', phone: '', role: UserRole.INVENTORY },
  });

  const mutation = useMutation({
    mutationFn: (data: CreateUserInput) =>
      isEdit
        ? apiPut<{ user: User }>(`/users/${user.userId}`, data)
        : apiPost<{ user: User; tempPassword: string }>('/users', data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      if (isEdit) {
        toast.success('User updated');
        onClose();
        return;
      }
      // Show the credentials handoff view. Phone for WhatsApp link comes
      // from the form (the API normalises empty → null on the user row).
      const created = (result as { user: User; tempPassword: string });
      const submitted = getValues();
      setCreatedCreds({
        name: `${submitted.firstName} ${submitted.lastName}`.trim(),
        email: created.user.email,
        phone: (submitted.phone || created.user.phone || '').toString(),
        tempPassword: created.tempPassword,
      });
      toast.success('User created');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const roleOptions = [
    { value: UserRole.DISTRIBUTOR_ADMIN, label: 'Distributor Admin' },
    { value: UserRole.FINANCE, label: 'Finance' },
    { value: UserRole.INVENTORY, label: 'Inventory' },
    { value: UserRole.DRIVER, label: 'Driver' },
    { value: UserRole.CUSTOMER, label: 'Customer' },
  ];

  // Credentials handoff view — replaces the form on successful create.
  if (createdCreds) {
    return (
      <Modal
        open={open}
        onClose={() => { setCreatedCreds(null); onClose(); }}
        title="User created — share credentials"
      >
        <CreatedCredentialsView
          creds={createdCreds}
          onDone={() => { setCreatedCreds(null); onClose(); }}
        />
      </Modal>
    );
  }

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

function CreatedCredentialsView({ creds, onDone }: { creds: CreatedCreds; onDone: () => void }) {
  const loginUrl = `${window.location.origin}/login`;
  const waText = `Your MyGasLink login\n\nLogin: ${loginUrl}\nEmail: ${creds.email}\nTemporary password: ${creds.tempPassword}\n\nYou'll be asked to change this on first login.`;
  const waPhone = (creds.phone || '').replace(/\D/g, '');
  const waUrl = waPhone
    ? `https://wa.me/${waPhone.startsWith('91') || waPhone.length === 10 ? (waPhone.length === 10 ? '91' + waPhone : waPhone) : waPhone}?text=${encodeURIComponent(waText)}`
    : null;

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error('Copy failed — please select manually'),
    );
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
        We&apos;ve emailed the user a welcome message with these credentials. As a fallback,
        copy or WhatsApp them directly — the temporary password is shown <strong>only on this screen</strong>.
      </div>

      <div className="space-y-2 rounded-xl border border-surface-200 dark:border-surface-700 p-4">
        <CredRow label="Name" value={creds.name} />
        <CredRow label="Email" value={creds.email} onCopy={() => copy(creds.email, 'Email')} />
        <CredRow label="Phone" value={creds.phone || '—'} />
        <CredRow
          label="Temporary password"
          value={creds.tempPassword}
          mono
          highlight
          onCopy={() => copy(creds.tempPassword, 'Password')}
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
        <Button type="button" variant="secondary" onClick={() => copy(waText, 'Full message')}>
          <HiOutlineClipboardDocument className="h-4 w-4" />Copy full message
        </Button>
        {waUrl ? (
          <a
            href={waUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            <HiOutlineChatBubbleLeftRight className="h-4 w-4" />Open in WhatsApp
          </a>
        ) : (
          <span className="text-xs text-surface-500">
            Add a phone number to enable WhatsApp share
          </span>
        )}
        <Button type="button" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

function CredRow({
  label,
  value,
  mono,
  highlight,
  onCopy,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
  onCopy?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-surface-500 w-36 shrink-0">{label}</span>
      <span
        className={cn(
          'flex-1 truncate text-sm',
          mono && 'font-mono',
          highlight && 'rounded-md bg-flame-50 dark:bg-flame-500/10 px-2 py-1 text-flame-700 dark:text-flame-300',
        )}
      >
        {value}
      </span>
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          className="rounded-md p-1.5 text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-700"
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
        >
          <HiOutlineClipboardDocument className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

// ─── Licenses Tab ──────────────────────────────────────────────────────────

function LicensesTab() {
  const queryClient = useQueryClient();
  const distributorId = useAuthStore(selectDistributorId);
  const [formOpen, setFormOpen] = useState(false);

  const { data: licenses, isLoading } = useQuery({
    queryKey: ['licenses', distributorId],
    queryFn: () => apiGet<License[]>('/licenses'),
    enabled: !!distributorId,
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
  const distributorId = useAuthStore(selectDistributorId);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const { data: catalogData, isLoading } = useQuery({
    queryKey: ['provider-catalog-for-distributor', distributorId],
    queryFn: () => apiGet<{ items: CatalogItem[]; providers: string[] }>('/provider-catalog/for-distributor'),
    enabled: !!distributorId,
  });

  const { data: existingTypes } = useQuery({
    queryKey: ['cylinder-types', distributorId],
    queryFn: () => apiGet<{ cylinderTypes: Array<{ cylinderTypeId: string; typeName: string; capacity: number; isActive: boolean }> }>('/cylinder-types'),
    enabled: !!distributorId,
  });

  const importMutation = useMutation({
    mutationFn: (catalogItemIds: string[]) =>
      apiPost<{ imported: number }>('/provider-catalog/import', { catalogItemIds }),
    onSuccess: (data) => {
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
  const distributorId = useAuthStore(selectDistributorId);
  const fmt = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);

  const { data: billingData, isLoading } = useQuery({
    queryKey: ['my-billing-cycles', distributorId],
    queryFn: () => apiGet<{ cycles: Array<{
      cycleId: string; periodType: string; periodStartDate: string; periodEndDate: string;
      totalAmountExclGst: number; totalGstAmount: number; totalAmountInclGst: number;
      billingStatus: string; dueDate: string | null;
      items: Array<{ itemId: string; itemType: string; description: string; quantity: number; unitPriceExclGst: number; lineTotalInclGst: number }>;
    }> }>('/billing/cycles'),
    enabled: !!distributorId,
  });

  const { data: seatData } = useQuery({
    queryKey: ['my-seat-limits', distributorId],
    queryFn: () => apiGet<{ plan: string; limits: Record<string, { allowed: number; used: number; extraPrice: number }> | null; gstApi: { included: number; overagePrice: number }; customerPortalPrice: number }>('/pricing/seat-limits'),
    enabled: !!distributorId,
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
