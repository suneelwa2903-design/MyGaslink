/**
 * Group A Step 8 — Super-admin GST activation screen.
 *
 * Flow:
 *   1. Render distributor info + current state
 *   2. User picks target mode (Disabled / Live / Sandbox-if-test-tenant)
 *   3. For Live/Sandbox: user enters Layer 2 creds (einvoice + optional ewb)
 *   4. User clicks "Test Connection" → renders per-scope OK/fail
 *   5. Test Connection green ⇒ Activate button enabled
 *   6. Activate → POST /api/admin/distributors/:id/gst/activate (atomic)
 *      Disable → POST /api/admin/distributors/:id/gst/disable
 *
 * Layer 1 (client_id + client_secret) is NOT collected here — that's read
 * from server env vars at runtime per Group A architecture.
 */
import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import {
  HiOutlineArrowLeft,
  HiOutlineCheckCircle,
  HiOutlineXCircle,
  HiOutlineShieldCheck,
  HiOutlineInformationCircle,
} from 'react-icons/hi2';
import type { Distributor } from '@gaslink/shared';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Loader, Badge } from '@/components/ui';
import { cn } from '@/lib/cn';

type TargetMode = 'disabled' | 'sandbox' | 'live';
type Scope = 'einvoice' | 'ewaybill';

interface Layer2Creds {
  username: string;
  password: string;
}

interface ActivationFormFields {
  username: string;
  password: string;
  // ewaybill-specific (only used if sameCreds === false)
  ewbUsername: string;
  ewbPassword: string;
  reason: 'new_distributor_activation' | 'credential_rotation' | 'mode_change' | 'revoke_access' | 'other';
  reasonText: string;
}

interface DisableFormFields {
  reason: 'new_distributor_activation' | 'credential_rotation' | 'mode_change' | 'revoke_access' | 'other';
  reasonText: string;
}

interface TestConnectionResult {
  scope: Scope;
  authenticated: boolean;
  nicReachable: boolean;
  message: string;
  authError?: string;
  nicError?: string;
}

const REASON_OPTIONS = [
  { value: 'new_distributor_activation', label: 'New distributor activation' },
  { value: 'credential_rotation', label: 'Credential rotation' },
  { value: 'mode_change', label: 'Mode change' },
  { value: 'revoke_access', label: 'Revoke access' },
  { value: 'other', label: 'Other (specify below)' },
];

export default function GstActivationPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: distributor, isLoading } = useQuery({
    queryKey: ['distributor', id],
    queryFn: () => apiGet<Distributor>(`/distributors/${id}`),
    enabled: !!id,
  });

  if (isLoading) {
    return <div className="flex justify-center py-20"><Loader size="lg" /></div>;
  }
  if (!distributor) {
    return <div className="text-center py-20 text-surface-500">Distributor not found</div>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate(`/app/distributors/${id}`)}
          className="p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700"
          aria-label="Back to distributor"
        >
          <HiOutlineArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">GST Activation</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
            {distributor.businessName} — configure GST mode and WhiteBooks credentials
          </p>
        </div>
      </div>

      {/* Distributor info */}
      <div className="card p-5 space-y-3">
        <h2 className="text-lg font-semibold text-surface-900 dark:text-white flex items-center gap-2">
          <HiOutlineShieldCheck className="h-5 w-5 text-brand-500" />
          Distributor
        </h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <InfoRow label="Business Name" value={distributor.businessName} />
          <InfoRow label="Legal Name" value={distributor.legalName} />
          <InfoRow label="GSTIN" value={distributor.gstin || 'N/A'} mono />
          <InfoRow label="State" value={distributor.state || 'N/A'} />
          <InfoRow label="Email of record" value={distributor.email || 'N/A'} />
          <InfoRow label="Test tenant" value={distributor.isTestTenant ? 'Yes' : 'No'} />
          <div className="col-span-2 flex items-center gap-2 pt-2 border-t border-surface-200 dark:border-surface-700">
            <span className="text-xs text-surface-500 dark:text-surface-400">Current GST Mode:</span>
            <Badge
              variant={
                distributor.gstMode === 'live'
                  ? 'success'
                  : distributor.gstMode === 'sandbox'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {distributor.gstMode}
            </Badge>
          </div>
        </div>
      </div>

      {/* Activation form */}
      <ActivationForm
        distributor={distributor}
        onActivated={() => {
          toast.success('GST activated');
          navigate(`/app/distributors/${id}`);
        }}
        onDisabled={() => {
          toast.success('GST disabled');
          navigate(`/app/distributors/${id}`);
        }}
      />
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-surface-500 dark:text-surface-400">{label}</div>
      <div
        className={cn(
          'text-sm font-medium text-surface-900 dark:text-white',
          mono && 'font-mono',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function ActivationForm({
  distributor,
  onActivated,
  onDisabled,
}: {
  distributor: Distributor;
  onActivated: () => void;
  onDisabled: () => void;
}) {
  const [targetMode, setTargetMode] = useState<TargetMode>(
    distributor.gstMode === 'disabled' ? 'live' : 'disabled',
  );
  const [sameCreds, setSameCreds] = useState(true);
  const [testResults, setTestResults] = useState<{ einvoice?: TestConnectionResult; ewaybill?: TestConnectionResult }>({});
  const [testRanForMode, setTestRanForMode] = useState<TargetMode | null>(null);

  const isDisableFlow = targetMode === 'disabled';

  const activationForm = useForm<ActivationFormFields>({
    defaultValues: {
      username: '',
      password: '',
      ewbUsername: '',
      ewbPassword: '',
      reason: 'new_distributor_activation',
      reasonText: '',
    },
  });

  const disableForm = useForm<DisableFormFields>({
    defaultValues: {
      reason: 'mode_change',
      reasonText: '',
    },
  });

  const testMutation = useMutation({
    mutationFn: async ({ scope, creds }: { scope: Scope; creds: Layer2Creds }) =>
      apiPost<TestConnectionResult>(`/admin/distributors/${distributor.distributorId}/gst/test-connection`, {
        scope,
        mode: targetMode === 'disabled' ? 'sandbox' : targetMode,
        credentials: creds,
      }),
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const handleTestConnection = async () => {
    const v = activationForm.getValues();
    const einCreds: Layer2Creds = { username: v.username, password: v.password };
    const ewbCreds: Layer2Creds = sameCreds
      ? einCreds
      : { username: v.ewbUsername, password: v.ewbPassword };

    if (!einCreds.username || !einCreds.password) {
      toast.error('Fill the e-Invoice username and password before testing');
      return;
    }
    if (!sameCreds && (!ewbCreds.username || !ewbCreds.password)) {
      toast.error('Fill the e-Way Bill username and password before testing');
      return;
    }

    setTestResults({});
    const ein = await testMutation.mutateAsync({ scope: 'einvoice', creds: einCreds });
    const ewb = await testMutation.mutateAsync({ scope: 'ewaybill', creds: ewbCreds });
    setTestResults({ einvoice: ein, ewaybill: ewb });
    setTestRanForMode(targetMode);
  };

  const bothTestsPassed =
    !!testResults.einvoice?.authenticated &&
    !!testResults.ewaybill?.authenticated &&
    testRanForMode === targetMode;

  const activateMutation = useMutation({
    mutationFn: async (body: ActivationFormFields) => {
      const ein: Layer2Creds = { username: body.username, password: body.password };
      const ewb = sameCreds
        ? 'same_as_einvoice'
        : { username: body.ewbUsername, password: body.ewbPassword };
      const payload = {
        mode: targetMode === 'disabled' ? 'live' : targetMode,
        einvoice: ein,
        ewaybill: ewb,
        reason: body.reason,
        ...(body.reason === 'other' ? { reasonText: body.reasonText } : {}),
      };
      return apiPost<{ gstMode: TargetMode; einvoiceFingerprint: string; ewaybillFingerprint: string }>(
        `/admin/distributors/${distributor.distributorId}/gst/activate`,
        payload,
      );
    },
    onSuccess: onActivated,
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const disableMutation = useMutation({
    mutationFn: async (body: DisableFormFields) =>
      apiPost(`/admin/distributors/${distributor.distributorId}/gst/disable`, {
        reason: body.reason,
        ...(body.reason === 'other' ? { reasonText: body.reasonText } : {}),
      }),
    onSuccess: onDisabled,
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  // Target mode picker
  return (
    <div className="card p-5 space-y-5">
      <h2 className="text-lg font-semibold text-surface-900 dark:text-white">Target Mode</h2>
      <div className="grid grid-cols-3 gap-2">
        {(['disabled', 'live', 'sandbox'] as const).map((m) => {
          const sandboxBlocked = m === 'sandbox' && !distributor.isTestTenant;
          const isActive = targetMode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => {
                if (sandboxBlocked) {
                  toast.error('Sandbox is reserved for internal test tenants only');
                  return;
                }
                setTargetMode(m);
                setTestResults({});
                setTestRanForMode(null);
              }}
              disabled={sandboxBlocked}
              className={cn(
                'p-3 rounded-lg border-2 text-sm font-medium transition-colors',
                isActive
                  ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
                  : 'border-surface-200 dark:border-surface-700 text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800',
                sandboxBlocked && 'opacity-40 cursor-not-allowed',
              )}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
              {sandboxBlocked && <div className="text-xs font-normal mt-0.5">(test tenants only)</div>}
            </button>
          );
        })}
      </div>

      {isDisableFlow ? (
        <DisableSection
          form={disableForm}
          submitting={disableMutation.isPending}
          onSubmit={() => disableForm.handleSubmit((d) => disableMutation.mutate(d))()}
          onCancel={() => window.history.back()}
        />
      ) : (
        <ActivateSection
          form={activationForm}
          targetMode={targetMode}
          sameCreds={sameCreds}
          setSameCreds={(v) => {
            setSameCreds(v);
            setTestResults({});
            setTestRanForMode(null);
          }}
          testResults={testResults}
          testRanForMode={testRanForMode}
          testing={testMutation.isPending}
          onTestConnection={handleTestConnection}
          activating={activateMutation.isPending}
          activateEnabled={bothTestsPassed}
          onActivate={() => activationForm.handleSubmit((d) => activateMutation.mutate(d))()}
          onCancel={() => window.history.back()}
        />
      )}
    </div>
  );
}

function ActivateSection({
  form,
  targetMode,
  sameCreds,
  setSameCreds,
  testResults,
  testRanForMode,
  testing,
  onTestConnection,
  activating,
  activateEnabled,
  onActivate,
  onCancel,
}: {
  form: ReturnType<typeof useForm<ActivationFormFields>>;
  targetMode: TargetMode;
  sameCreds: boolean;
  setSameCreds: (v: boolean) => void;
  testResults: { einvoice?: TestConnectionResult; ewaybill?: TestConnectionResult };
  testRanForMode: TargetMode | null;
  testing: boolean;
  onTestConnection: () => void;
  activating: boolean;
  activateEnabled: boolean;
  onActivate: () => void;
  onCancel: () => void;
}) {
  const { register, watch } = form;
  const reason = watch('reason');

  return (
    <div className="space-y-5">
      {/* Same-creds toggle */}
      <div className="flex items-center justify-between p-3 rounded-lg bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
        <div>
          <div className="text-sm font-medium text-surface-900 dark:text-white">
            Same credentials for e-invoice and e-Way Bill
          </div>
          <div className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
            Most taxpayers use the same NIC username + password for both portals.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSameCreds(!sameCreds)}
          className={cn(
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
            sameCreds ? 'bg-brand-500' : 'bg-surface-300 dark:bg-surface-600',
          )}
          aria-pressed={sameCreds}
          aria-label="Toggle same credentials"
        >
          <span
            className={cn(
              'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
              sameCreds ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
      </div>

      {/* Group A revision: only username + password are per-distributor.
          client_id, client_secret, AND email are GasLink-global env vars —
          shared across all distributors. Email is the WhiteBooks email-of-
          record for MyGasLink's own account in this (scope × mode) pair. */}
      <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-xs text-blue-700 dark:text-blue-300 flex items-start gap-2">
        <HiOutlineInformationCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <span>
          Only NIC username + password are per-distributor. The WhiteBooks
          client credentials and email-of-record are GasLink-global and live
          in the platform environment — you do not collect them from the
          distributor.
        </span>
      </div>

      {/* einvoice creds */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
          e-Invoice Credentials
        </h3>
        <CredField
          label="NIC Portal Username"
          hint="username"
          {...register('username', { required: true })}
          autoComplete="off"
        />
        <CredField
          label="NIC Portal Password"
          hint="password"
          type="password"
          {...register('password', { required: true })}
          autoComplete="new-password"
        />
      </div>

      {/* ewaybill creds — collapsed when same */}
      {sameCreds ? (
        <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800 border border-dashed border-surface-300 dark:border-surface-600 text-sm text-surface-600 dark:text-surface-400 flex items-center gap-2">
          <HiOutlineInformationCircle className="h-4 w-4" />
          Using e-invoice credentials for the e-Way Bill scope.
        </div>
      ) : (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
            e-Way Bill Credentials
          </h3>
          <CredField
            label="EWB Portal Username"
            hint="username"
            {...register('ewbUsername', { required: !sameCreds })}
            autoComplete="off"
          />
          <CredField
            label="EWB Portal Password"
            hint="password"
            type="password"
            {...register('ewbPassword', { required: !sameCreds })}
            autoComplete="new-password"
          />
        </div>
      )}

      {/* Reason */}
      <div className="space-y-2">
        <Select
          label="Reason"
          options={REASON_OPTIONS}
          {...register('reason', { required: true })}
        />
        {reason === 'other' && (
          <Input
            label="Please specify"
            placeholder="Migration from legacy GSP, audit requirement, etc."
            {...register('reasonText', { required: reason === 'other' })}
          />
        )}
      </div>

      {/* Test Connection results */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
            Test Connection
          </h3>
          <Button variant="secondary" size="sm" onClick={onTestConnection} loading={testing}>
            Run Test
          </Button>
        </div>
        {(testResults.einvoice || testResults.ewaybill) && (
          <div className="rounded-md border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 p-3 space-y-1 text-sm">
            <TestRow scope="einvoice" result={testResults.einvoice} />
            <TestRow scope="ewaybill" result={testResults.ewaybill} />
            {testRanForMode && testRanForMode !== targetMode && (
              <div className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                Mode changed since last test — please re-run Test Connection.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-2 border-t border-surface-200 dark:border-surface-700">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          onClick={onActivate}
          loading={activating}
          disabled={!activateEnabled}
          title={!activateEnabled ? 'Run Test Connection successfully before activating' : undefined}
        >
          Activate ({targetMode})
        </Button>
      </div>
    </div>
  );
}

function DisableSection({
  form,
  submitting,
  onSubmit,
  onCancel,
}: {
  form: ReturnType<typeof useForm<DisableFormFields>>;
  submitting: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { register, watch } = form;
  const reason = watch('reason');

  return (
    <div className="space-y-5">
      <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-700 dark:text-amber-300 flex gap-2">
        <HiOutlineInformationCircle className="h-5 w-5 flex-shrink-0" />
        <div>
          Disabling GST stops all WhiteBooks calls for this distributor.
          Credentials are preserved; you can re-activate later. If any GST
          documents are still in flight (open EWBs or pending IRNs), the
          backend blocks the disable with a clear error.
        </div>
      </div>

      <Select
        label="Reason"
        options={REASON_OPTIONS}
        {...register('reason', { required: true })}
      />
      {reason === 'other' && (
        <Input
          label="Please specify"
          placeholder="Customer-initiated suspension, end-of-pilot, etc."
          {...register('reasonText', { required: reason === 'other' })}
        />
      )}

      <div className="flex items-center justify-between pt-2 border-t border-surface-200 dark:border-surface-700">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onSubmit} loading={submitting}>
          Disable GST
        </Button>
      </div>
    </div>
  );
}

interface CredFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
}

const CredField = (props: CredFieldProps) => {
  const { label, hint, ...inputProps } = props;
  return (
    <div>
      <label className="block text-sm font-medium text-surface-700 dark:text-surface-300">
        {label}
        {hint && (
          <span className="ml-2 text-xs font-mono text-surface-400 dark:text-surface-500">
            {hint}
          </span>
        )}
      </label>
      <input
        className="mt-1 w-full rounded-md border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-900 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
        {...inputProps}
      />
    </div>
  );
};

function TestRow({ scope, result }: { scope: Scope; result?: TestConnectionResult }) {
  if (!result) {
    return (
      <div className="flex items-center gap-2 text-surface-400">
        <span className="inline-block h-2 w-2 rounded-full bg-current" />
        <span>{scope === 'einvoice' ? 'e-Invoice' : 'e-Way Bill'}: pending</span>
      </div>
    );
  }
  const ok = result.authenticated && result.nicReachable;
  return (
    <div className={cn('flex items-center gap-2', ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>
      {ok ? <HiOutlineCheckCircle className="h-4 w-4" /> : <HiOutlineXCircle className="h-4 w-4" />}
      <span className="font-medium">{scope === 'einvoice' ? 'e-Invoice' : 'e-Way Bill'}:</span>
      <span>{result.message}</span>
    </div>
  );
}
