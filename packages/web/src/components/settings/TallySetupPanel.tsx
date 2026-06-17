/**
 * Tally Setup — Settings → Tally tab.
 *
 * Pure UI form; no file handling. Fetches GET /api/tally-settings on mount
 * (which also returns the tenant's active cylinder types so the mapping
 * section can render without a second round trip), pre-fills form state,
 * and PUTs the whole form on Save.
 *
 * Sections (per the WI spec):
 *   1. Tally Version    — radio cards (prime / erp9)
 *   2. Company Identity — optional tallyCompanyName override
 *   3. Ledger Names     — 8 inputs (sales / CGST / SGST / IGST / cash / bank / Sundry Debtors / Round Off)
 *   4. Voucher Types    — 4 inputs
 *   5. Inventory        — 1 input (stockUnit)
 *   6. Cylinder Mapping — one row per active CylinderType
 *
 * The "unsaved changes guard" uses window.beforeunload only — Apple-style
 * browser confirm when the user hard-navigates / reloads / closes tab. SPA
 * in-app navigation is NOT intercepted; per the WI spec that is post-launch
 * work (would need react-router's useBlocker).
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { HiOutlineArrowRight, HiOutlineCheckCircle, HiOutlineExclamationTriangle } from 'react-icons/hi2';
import { apiGet, apiPut, getErrorMessage } from '@/lib/api';
import { Button, Input, Loader, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';

// ─── Types matching the API wire shape ──────────────────────────────────────
//
// Anti-pattern #9 guard: the TS shape must mirror what GET /api/tally-settings
// actually returns. Wire-shape assertion lives in
// packages/api/src/__tests__/tally-export.test.ts test #1.

interface TallySettingsValues {
  tallyVersion: 'prime' | 'erp9';
  tallyCompanyName: string | null;
  ledgerSales: string;
  ledgerCgst: string;
  ledgerSgst: string;
  ledgerIgst: string;
  ledgerCash: string;
  ledgerBank: string;
  ledgerSundryDebtors: string;
  ledgerRoundOff: string;
  voucherTypeSales: string;
  voucherTypeReceipt: string;
  voucherTypeCreditNote: string;
  voucherTypeDebitNote: string;
  stockUnit: string;
  cylinderStockItems: Record<string, string>;
}

interface CylinderTypeMapping {
  id: string;
  typeName: string;
  capacity: number;
  mappedTallyName: string;
}

interface TallySettingsResponse {
  isConfigured: boolean;
  updatedAt: string | null;
  settings: TallySettingsValues;
  cylinderTypes: CylinderTypeMapping[];
}

// Server returns 400 with either Zod fieldErrors (under `details`) or a
// global error message (e.g. UNKNOWN_CYLINDER_TYPE). We extract both.
type FieldErrors = Partial<Record<keyof TallySettingsValues, string[]>>;

interface ApiErrorBody {
  error?: string;
  code?: string;
  details?: FieldErrors;
}

// ─── Section primitives (matching SettingsPage conventions) ─────────────────

function Section({ title, helper, children }: { title: string; helper?: string; children: React.ReactNode }) {
  return (
    <div className="card p-6 space-y-5">
      <div>
        <h3 className="font-semibold text-surface-900 dark:text-white">{title}</h3>
        {helper && <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">{helper}</p>}
      </div>
      {children}
    </div>
  );
}

/**
 * Two-column "label + helper / input" grid row. Matches the
 * PaymentDetailsSection convention in SettingsPage.tsx — left side is the
 * descriptive text, right side is a single Input. Stacks on mobile.
 */
function LabelledRow({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
      <div>
        <div className="font-medium text-surface-800 dark:text-surface-200 text-sm">{label}</div>
        {helper && <div className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">{helper}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

interface VersionCardProps {
  selected: boolean;
  title: string;
  subtitle?: string;
  onClick: () => void;
}

function VersionCard({ selected, title, subtitle, onClick }: VersionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 rounded-xl border-2 p-5 text-left transition',
        selected
          ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 text-brand-900 dark:text-brand-100'
          : 'border-surface-200 dark:border-surface-700 hover:border-surface-300',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-semibold">{title}</span>
        {selected && <HiOutlineCheckCircle className="h-5 w-5 text-brand-500" />}
      </div>
      {subtitle && <div className="text-xs text-surface-500 dark:text-surface-400 mt-1">{subtitle}</div>}
    </button>
  );
}

// ─── Main panel ─────────────────────────────────────────────────────────────

export default function TallySetupPanel() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tally-settings'],
    queryFn: () => apiGet<TallySettingsResponse>('/tally-settings'),
  });

  // Form state. Initialised from server data; tracked locally so the form
  // remains editable without re-fetch flapping. `isDirty` powers both the
  // Save button enabled-state and the beforeunload guard.
  const [form, setForm] = useState<TallySettingsValues | null>(null);
  const [cylinderMappingDraft, setCylinderMappingDraft] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [isDirty, setIsDirty] = useState(false);

  // Sync server data into form state ONCE per identity change — same guard
  // pattern as PaymentDetailsSection in SettingsPage (anti-pattern: cascading
  // setState in useEffect masks lint errors).
  useEffect(() => {
    if (!data) return;
    setForm({ ...data.settings });
    // Seed the mapping draft from the resolved per-cylinder mappedTallyName.
    // This means "show the fallback (typeName) in the input box for unmapped
    // cylinders" — but we only PERSIST a key when the user has actually
    // typed something different than the fallback (resolved below at save).
    const initial: Record<string, string> = {};
    for (const ct of data.cylinderTypes) {
      initial[ct.id] = ct.mappedTallyName;
    }
    setCylinderMappingDraft(initial);
    setIsDirty(false);
    setFieldErrors({});
  }, [data]);

  // beforeunload guard: only when the user has unsaved changes.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern browsers show a generic message; the returnValue text is
      // ignored but setting it is what triggers the dialog in older
      // engines.
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const cylinderTypes = data?.cylinderTypes ?? [];

  // Build the cylinderStockItems map for PUT. Only persist entries the user
  // typed AND that differ from the typeName fallback — saving the fallback
  // would pollute the JSON with redundant data and make a "reset mapping"
  // operation harder.
  const buildCylinderStockItems = useMemo(() => {
    return (): Record<string, string> => {
      const result: Record<string, string> = {};
      for (const ct of cylinderTypes) {
        const v = cylinderMappingDraft[ct.id]?.trim();
        if (v && v !== ct.typeName) {
          result[ct.id] = v;
        }
      }
      return result;
    };
  }, [cylinderTypes, cylinderMappingDraft]);

  const mutation = useMutation({
    mutationFn: (body: TallySettingsValues) => apiPut<TallySettingsResponse>('/tally-settings', body),
    onSuccess: (resp) => {
      toast.success('Tally settings saved');
      // Hand the freshly-saved values into the query cache so isConfigured
      // + updatedAt update without a refetch round-trip.
      queryClient.setQueryData(['tally-settings'], resp);
      setIsDirty(false);
      setFieldErrors({});
    },
    onError: (err: unknown) => {
      // Extract field errors when the server returned 400 with Zod fieldErrors.
      // Otherwise fall through to a single toast with the API error message.
      const body = extractApiErrorBody(err);
      if (body?.details) {
        setFieldErrors(body.details);
        toast.error('Some fields need attention');
      } else {
        toast.error(getErrorMessage(err));
      }
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader size="lg" />
      </div>
    );
  }
  if (isError || !data || !form) {
    return (
      <EmptyState title="Could not load Tally settings" description={getErrorMessage(error)} />
    );
  }

  // ─── Field update helpers ──────────────────────────────────────────

  function update<K extends keyof TallySettingsValues>(key: K, value: TallySettingsValues[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setIsDirty(true);
    // Clear field error as soon as the user starts editing — fresh attempt
    // shouldn't show stale red.
    if (fieldErrors[key]) {
      setFieldErrors((fe) => {
        const next = { ...fe };
        delete next[key];
        return next;
      });
    }
  }

  function setMapping(cylinderTypeId: string, value: string) {
    setCylinderMappingDraft((prev) => ({ ...prev, [cylinderTypeId]: value }));
    setIsDirty(true);
  }

  // ─── Save handler with client-side guard ───────────────────────────

  function clientValidate(): FieldErrors {
    const errs: FieldErrors = {};
    const required: (keyof TallySettingsValues)[] = [
      'ledgerSales', 'ledgerCgst', 'ledgerSgst', 'ledgerIgst',
      'ledgerCash', 'ledgerBank', 'ledgerSundryDebtors', 'ledgerRoundOff',
      'voucherTypeSales', 'voucherTypeReceipt', 'voucherTypeCreditNote', 'voucherTypeDebitNote',
      'stockUnit',
    ];
    for (const k of required) {
      const v = form?.[k];
      if (typeof v === 'string' && v.trim().length === 0) {
        errs[k] = ['Required'];
      }
    }
    return errs;
  }

  function handleSave() {
    if (!form) return;
    const clientErrs = clientValidate();
    if (Object.keys(clientErrs).length > 0) {
      setFieldErrors(clientErrs);
      toast.error('Some fields are blank');
      return;
    }
    const body: TallySettingsValues = {
      ...form,
      tallyCompanyName: form.tallyCompanyName?.trim() ? form.tallyCompanyName.trim() : null,
      cylinderStockItems: buildCylinderStockItems(),
    };
    mutation.mutate(body);
  }

  // ─── Render ────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Top status banner / badge. */}
      {data.isConfigured ? (
        <div className="card p-4 flex items-center gap-3 border-l-4 border-l-green-500">
          <HiOutlineCheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
          <div>
            <div className="font-medium text-surface-900 dark:text-white">Tally Configured</div>
            {data.updatedAt && (
              <div className="text-xs text-surface-500 dark:text-surface-400">
                Last updated: {new Date(data.updatedAt).toLocaleString('en-IN')}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="card p-4 flex items-start gap-3 border-l-4 border-l-amber-500 bg-amber-50/40 dark:bg-amber-900/10">
          <HiOutlineExclamationTriangle className="h-6 w-6 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <div className="text-sm text-surface-800 dark:text-surface-200">
            Tally export is not set up yet. Fill in your ledger names below and
            save to enable Tally export from the Reports tab.
          </div>
        </div>
      )}

      {/* 1. Tally Version */}
      <Section title="Tally Version" helper="Which version of Tally are you using?">
        <div className="flex flex-col sm:flex-row gap-3">
          <VersionCard
            selected={form.tallyVersion === 'prime'}
            title="Tally Prime"
            subtitle="Recommended"
            onClick={() => update('tallyVersion', 'prime')}
          />
          <VersionCard
            selected={form.tallyVersion === 'erp9'}
            title="Tally ERP 9"
            onClick={() => update('tallyVersion', 'erp9')}
          />
        </div>
      </Section>

      {/* 2. Company Identity */}
      <Section
        title="Company Name in Tally"
        helper="The exact company name shown at the top of your Gateway of Tally screen. Leave blank to use your registered legal name from GSTIN."
      >
        <Input
          value={form.tallyCompanyName ?? ''}
          placeholder="e.g. Vanasthali Gas Service"
          onChange={(e) => update('tallyCompanyName', e.target.value)}
        />
      </Section>

      {/* 3. Ledger Names */}
      <Section
        title="Ledger Names"
        helper="Enter the exact ledger names as they appear in your Tally Chart of Accounts. Gateway of Tally → Chart of Accounts → Ledgers"
      >
        <div className="space-y-4">
          <LedgerRow label="Sales Account" helper="Your sales income ledger"
            value={form.ledgerSales} error={fieldErrors.ledgerSales}
            onChange={(v) => update('ledgerSales', v)} />
          <LedgerRow label="CGST Collected" helper="CGST on intrastate sales. Usually under Duties & Taxes."
            value={form.ledgerCgst} error={fieldErrors.ledgerCgst}
            onChange={(v) => update('ledgerCgst', v)} />
          <LedgerRow label="SGST Collected" helper="SGST on intrastate sales."
            value={form.ledgerSgst} error={fieldErrors.ledgerSgst}
            onChange={(v) => update('ledgerSgst', v)} />
          <LedgerRow label="IGST Collected" helper="IGST on interstate sales."
            value={form.ledgerIgst} error={fieldErrors.ledgerIgst}
            onChange={(v) => update('ledgerIgst', v)} />
          <LedgerRow label="Cash Ledger" helper="For cash payment receipts."
            value={form.ledgerCash} error={fieldErrors.ledgerCash}
            onChange={(v) => update('ledgerCash', v)} />
          <LedgerRow label="Bank Ledger" helper="For bank/UPI/cheque receipts."
            value={form.ledgerBank} error={fieldErrors.ledgerBank}
            onChange={(v) => update('ledgerBank', v)} />
          <LedgerRow label="Sundry Debtors Group" helper="The group your customer ledgers are created under."
            value={form.ledgerSundryDebtors} error={fieldErrors.ledgerSundryDebtors}
            onChange={(v) => update('ledgerSundryDebtors', v)} />
          <LedgerRow label="Round Off" helper="For rounding differences on invoice totals."
            value={form.ledgerRoundOff} error={fieldErrors.ledgerRoundOff}
            onChange={(v) => update('ledgerRoundOff', v)} />
        </div>
      </Section>

      {/* 4. Voucher Type Names */}
      <Section
        title="Voucher Type Names"
        helper="The names of your voucher types in Tally. Gateway of Tally → Accounts Info → Voucher Types"
      >
        <div className="space-y-4">
          <LedgerRow label="Sales Voucher Type" helper="Usually Sales"
            value={form.voucherTypeSales} error={fieldErrors.voucherTypeSales}
            onChange={(v) => update('voucherTypeSales', v)} />
          <LedgerRow label="Receipt Voucher Type" helper="Usually Receipt"
            value={form.voucherTypeReceipt} error={fieldErrors.voucherTypeReceipt}
            onChange={(v) => update('voucherTypeReceipt', v)} />
          <LedgerRow label="Credit Note Voucher Type" helper="Usually Credit Note"
            value={form.voucherTypeCreditNote} error={fieldErrors.voucherTypeCreditNote}
            onChange={(v) => update('voucherTypeCreditNote', v)} />
          <LedgerRow label="Debit Note Voucher Type" helper="Usually Debit Note"
            value={form.voucherTypeDebitNote} error={fieldErrors.voucherTypeDebitNote}
            onChange={(v) => update('voucherTypeDebitNote', v)} />
        </div>
      </Section>

      {/* 5. Inventory Settings */}
      <Section
        title="Inventory Settings"
        helper="How cylinders appear in your Tally stock records."
      >
        <LedgerRow label="Unit of Measure" helper="The unit used for cylinders in Tally. Gateway of Tally → Inventory Info → Units of Measure"
          value={form.stockUnit} error={fieldErrors.stockUnit}
          onChange={(v) => update('stockUnit', v)} />
      </Section>

      {/* 6. Cylinder Mapping */}
      <Section
        title="Cylinder Stock Items"
        helper="Map each cylinder type in MyGasLink to its exact stock item name in Tally. Gateway of Tally → Inventory Info → Stock Items"
      >
        {cylinderTypes.length === 0 ? (
          <p className="text-sm text-surface-500 dark:text-surface-400">
            No cylinder types configured yet. Add cylinders first.
          </p>
        ) : (
          <div className="space-y-3">
            {cylinderTypes.map((ct) => (
              <div
                key={ct.id}
                className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-3 items-center"
              >
                <div className="font-medium text-surface-800 dark:text-surface-200 text-sm">
                  {ct.typeName}
                </div>
                <HiOutlineArrowRight className="h-4 w-4 text-surface-400 hidden md:block" />
                <Input
                  value={cylinderMappingDraft[ct.id] ?? ''}
                  placeholder="Exact stock item name in Tally"
                  onChange={(e) => setMapping(ct.id, e.target.value)}
                />
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 7. Save */}
      <div className="flex justify-end pt-2">
        <Button
          onClick={handleSave}
          loading={mutation.isPending}
          disabled={!isDirty}
        >
          Save Tally Settings
        </Button>
      </div>
    </div>
  );
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function LedgerRow({
  label, helper, value, error, onChange,
}: {
  label: string;
  helper?: string;
  value: string;
  error?: string[];
  onChange: (v: string) => void;
}) {
  return (
    <LabelledRow label={label} helper={helper}>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        error={error?.[0]}
      />
    </LabelledRow>
  );
}

/**
 * Pull `details` (Zod fieldErrors) off an axios error body. apiGet/apiPut
 * unwrap the success envelope; on error they re-throw the raw axios error
 * so the response body is reachable here.
 */
function extractApiErrorBody(err: unknown): ApiErrorBody | null {
  if (!err || typeof err !== 'object') return null;
  // axios error shape: { response: { data: { error, code, details } } }
  const e = err as { response?: { data?: ApiErrorBody } };
  return e.response?.data ?? null;
}
