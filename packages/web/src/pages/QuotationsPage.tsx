/**
 * Mini-op #7 (2026-07-27) — Quotations page.
 *
 * Route: /app/quotations. Reachable via sidebar for distributor_admin /
 * finance / mini_operator_admin / super_admin.
 *
 * View modes managed with a local URL-less state:
 *   list       — table of past quotes with status filter
 *   editor     — create-new OR edit-existing draft form
 *   view       — read-only render with Download PDF / Duplicate / Mark-sent
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineArrowDownTray,
  HiOutlineDocumentDuplicate, HiOutlineArrowLeft, HiOutlinePaperAirplane,
  HiOutlineEye, HiOutlineCheckCircle,
} from 'react-icons/hi2';
import {
  localTodayISO, QUOTATION_STATUSES, QUOTATION_GST_RATES, QUOTATION_CREDIT_TERMS_PRESETS,
  type CreateQuotationInput, type Quotation, type QuotationItemInput,
  type QuotationListRow, type QuotationStatusValue,
} from '@gaslink/shared';
import { api, apiGet, apiPost, apiPut, apiDelete, getErrorMessage } from '@/lib/api';
import { Button, Input, Loader, EmptyState, Select, Badge } from '@/components/ui';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });

const STATUS_LABELS: Record<QuotationStatusValue, string> = {
  draft: 'Draft', sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired',
};

const DEFAULT_TERMS = [
  'Prices are valid until the date shown above; beyond that a fresh quote will be issued.',
  'Statutory taxes as applicable are included where shown; changes in government levies apply automatically.',
  'Delivery within 24 working hours of confirmed order, subject to cylinder availability at the depot.',
  'A refundable security deposit is payable at first delivery for every new cylinder taken on rotation.',
  'Late payments beyond the agreed credit period attract 2% interest per month.',
  'Prices are subject to revision if statutory LPG rates are revised by the Government of India.',
  'Empty cylinders must be returned in undamaged condition; damages / shortages are chargeable at prevailing rates.',
];

interface ListResponse { quotations: QuotationListRow[]; meta: { page: number; pageSize: number; total: number; pageCount: number } }
// Wire shapes match what mappers.ts emits: customers get customerId (not id)
// via renameId() in mapCustomer, cylinder types get cylinderTypeId via
// mapCylinderTypes. Getting these wrong makes every option render with
// value="", which is the source of the React key warning + broken selection.
interface CustomerLite { customerId: string; customerName: string; gstin: string | null; phone: string | null }
interface CylinderTypeLite { cylinderTypeId: string; typeName: string; capacity: number; hsnCode: string }
/** Latest cylinder price per (distributor, type). Stored GST-INCLUSIVE per
 *  anti-pattern #16. Prisma Decimals serialise as strings — coerce with
 *  Number() before use. */
interface CylinderPriceRow {
  id: string;
  cylinderTypeId: string;
  price: string | number;     // Decimal-as-string; coerce with Number()
  effectiveDate: string;
  cylinderType?: { typeName: string };
}

type ViewMode =
  | { kind: 'list' }
  | { kind: 'editor'; quotationId?: string }
  | { kind: 'view'; quotationId: string };

export default function QuotationsPage() {
  const [mode, setMode] = useState<ViewMode>({ kind: 'list' });

  if (mode.kind === 'editor') {
    return (
      <QuotationEditor
        quotationId={mode.quotationId}
        onBack={() => setMode({ kind: 'list' })}
        onSaved={(id) => setMode({ kind: 'view', quotationId: id })}
      />
    );
  }
  if (mode.kind === 'view') {
    return (
      <QuotationView
        quotationId={mode.quotationId}
        onBack={() => setMode({ kind: 'list' })}
        onEdit={(id) => setMode({ kind: 'editor', quotationId: id })}
      />
    );
  }
  return (
    <QuotationsList
      onNew={() => setMode({ kind: 'editor' })}
      onOpen={(id) => setMode({ kind: 'view', quotationId: id })}
      onEdit={(id) => setMode({ kind: 'editor', quotationId: id })}
    />
  );
}

// ─── LIST VIEW ─────────────────────────────────────────────────────────────

function QuotationsList({
  onNew, onOpen, onEdit,
}: {
  onNew: () => void;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const listQuery = useQuery({
    queryKey: ['quotations', statusFilter],
    queryFn: () => apiGet<ListResponse>('/quotations', {
      ...(statusFilter ? { status: statusFilter } : {}),
      pageSize: 100,
    }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/quotations/${id}`),
    onSuccess: () => { toast.success('Draft deleted'); queryClient.invalidateQueries({ queryKey: ['quotations'] }); },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: string) => apiPost<Quotation>(`/quotations/${id}/duplicate`, {}),
    onSuccess: (clone) => {
      toast.success(`Duplicated as ${clone.quotationNumber}`);
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      onEdit(clone.quotationId);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const rows = listQuery.data?.quotations ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Quotations</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400">
            Rate quotes for prospective and existing customers. Duplicate any past quote for a monthly re-send.
          </p>
        </div>
        <Button onClick={onNew}>
          <HiOutlinePlus className="h-4 w-4" />
          New quotation
        </Button>
      </div>

      <div className="card p-4 flex flex-wrap gap-3 items-end">
        <Select
          label="Status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          options={[
            { value: '', label: 'All' },
            ...QUOTATION_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
          ]}
        />
      </div>

      {listQuery.isLoading ? (
        <div className="flex justify-center py-16"><Loader /></div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No quotations yet"
          description="Click New quotation to send your first rate quote."
          className="py-16"
        />
      ) : (
        <div className="card">
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Quote #</th>
                  <th>Date</th>
                  <th>Recipient</th>
                  <th>Subject</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.quotationId} className="cursor-pointer" onClick={() => onOpen(r.quotationId)}>
                    <td className="whitespace-nowrap font-medium">{r.quotationNumber}</td>
                    <td className="whitespace-nowrap">{r.quotationDate}</td>
                    <td className="max-w-xs truncate" title={r.recipientName}>{r.recipientName}</td>
                    <td className="max-w-md truncate" title={r.subject}>{r.subject}</td>
                    <td className="text-xs">
                      <Badge>{r.mode === 'per_cylinder' ? 'Per-cyl' : r.mode === 'per_kg' ? 'Per-KG' : 'Mixed'}</Badge>
                    </td>
                    <td><Badge>{STATUS_LABELS[r.status]}</Badge></td>
                    <td className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="inline-flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => onOpen(r.quotationId)} title="View">
                          <HiOutlineEye className="h-4 w-4" />
                        </Button>
                        {r.status === 'draft' && (
                          <Button variant="ghost" size="sm" onClick={() => onEdit(r.quotationId)} title="Edit">
                            <HiOutlinePencilSquare className="h-4 w-4" />
                          </Button>
                        )}
                        <Button variant="ghost" size="sm"
                          onClick={() => duplicateMutation.mutate(r.quotationId)}
                          disabled={duplicateMutation.isPending}
                          title="Duplicate for a new month">
                          <HiOutlineDocumentDuplicate className="h-4 w-4" />
                        </Button>
                        {r.status === 'draft' && (
                          <Button variant="ghost" size="sm"
                            onClick={() => { if (window.confirm('Delete this draft?')) deleteMutation.mutate(r.quotationId); }}
                            title="Delete draft">
                            <HiOutlineTrash className="h-4 w-4 text-red-500" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── EDITOR ────────────────────────────────────────────────────────────────

function QuotationEditor({
  quotationId, onBack, onSaved,
}: {
  quotationId?: string;
  onBack: () => void;
  onSaved: (id: string) => void;
}) {
  const isEdit = !!quotationId;
  const queryClient = useQueryClient();
  const today = localTodayISO();

  const existingQuery = useQuery({
    queryKey: ['quotation', quotationId],
    queryFn: () => apiGet<Quotation>(`/quotations/${quotationId}`),
    enabled: isEdit,
  });
  const customersQuery = useQuery({
    queryKey: ['customers-for-quote'],
    queryFn: () => apiGet<{ customers: CustomerLite[] }>('/customers', { pageSize: 500 }),
  });
  const typesQuery = useQuery({
    queryKey: ['cylinder-types-for-quote'],
    queryFn: () => apiGet<{ cylinderTypes: CylinderTypeLite[] }>('/cylinder-types'),
  });
  // Latest cylinder prices for auto-fill. Stored GST-inclusive so they
  // drop straight into priceInclGst / pricePerKgInclGst.
  const pricesQuery = useQuery({
    queryKey: ['cylinder-prices-for-quote'],
    queryFn: () => apiGet<CylinderPriceRow[]>('/cylinder-types/prices/list'),
  });

  const customers = customersQuery.data?.customers ?? [];
  const cylinderTypes = typesQuery.data?.cylinderTypes ?? [];
  // Build a Map: cylinderTypeId → latest price (rows are ordered by
  // effectiveDate desc; first occurrence wins). Prisma serialises Decimal
  // as string, so Number() is mandatory — passing a string into
  // toFixed()/divide would either NaN or silently concat.
  const latestPriceByTypeId = new Map<string, number>();
  for (const p of (pricesQuery.data ?? [])) {
    if (!latestPriceByTypeId.has(p.cylinderTypeId)) {
      const numeric = Number(p.price);
      if (Number.isFinite(numeric)) latestPriceByTypeId.set(p.cylinderTypeId, numeric);
    }
  }

  // Form state — plain useState rather than react-hook-form because
  // the dynamic item list is easier to manage manually.
  const [form, setForm] = useState<CreateQuotationInput>(() => defaultForm(today));
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');

  // Populate from existing draft
  useEffect(() => {
    if (isEdit && existingQuery.data) {
      const q = existingQuery.data;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm({
        quotationDate: q.quotationDate,
        validUntil: q.validUntil,
        customerId: q.customerId,
        recipientName: q.recipientName,
        recipientContactPerson: q.recipientContactPerson ?? undefined,
        recipientAddress: q.recipientAddress ?? undefined,
        recipientCity: q.recipientCity ?? undefined,
        recipientState: q.recipientState ?? undefined,
        recipientPincode: q.recipientPincode ?? undefined,
        recipientEmail: q.recipientEmail,
        ccEmails: q.ccEmails ?? [],
        recipientPhone: q.recipientPhone ?? undefined,
        recipientGstin: q.recipientGstin ?? undefined,
        subject: q.subject,
        coverText: q.coverText,
        footerNotes: q.footerNotes ?? undefined,
        terms: q.terms,
        creditTerms: q.creditTerms,
        gstRate: q.gstRate,
        items: q.items.map((it): QuotationItemInput =>
          it.kind === 'per_cylinder'
            ? {
                kind: 'per_cylinder',
                cylinderTypeId: it.cylinderTypeId,
                itemName: it.itemName,
                hsnCode: it.hsnCode,
                priceInclGst: it.priceInclGst ?? 0,
                discountInclGst: it.discountInclGst ?? 0,
                sortOrder: it.sortOrder,
                notes: it.notes ?? undefined,
              }
            : {
                kind: 'per_kg',
                cylinderTypeId: it.cylinderTypeId,
                itemName: it.itemName,
                hsnCode: it.hsnCode,
                cylinderCapacityKg: it.cylinderCapacityKg ?? 0,
                pricePerKgInclGst: it.pricePerKgInclGst ?? 0,
                discountPerKgInclGst: it.discountPerKgInclGst ?? 0,
                sortOrder: it.sortOrder,
                notes: it.notes ?? undefined,
              },
        ),
      });
      setSelectedCustomerId(q.customerId ?? '');
    }
  }, [isEdit, existingQuery.data]);

  const applyCustomerPrefill = (customerId: string) => {
    setSelectedCustomerId(customerId);
    if (!customerId) {
      setForm((f) => ({ ...f, customerId: null }));
      return;
    }
    const c = customers.find((cc) => cc.customerId === customerId);
    if (!c) return;
    setForm((f) => ({
      ...f,
      customerId,
      recipientName: c.customerName,
      recipientEmail: f.recipientEmail || 'customer@example.com',
      recipientPhone: c.phone ?? f.recipientPhone,
      recipientGstin: c.gstin ?? f.recipientGstin,
    }));
  };

  const saveMutation = useMutation({
    mutationFn: (payload: CreateQuotationInput) => (isEdit
      ? apiPut<Quotation>(`/quotations/${quotationId}`, payload)
      : apiPost<Quotation>('/quotations', payload)),
    onSuccess: (q) => {
      toast.success(isEdit ? 'Draft updated' : `Draft ${q.quotationNumber} created`);
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      queryClient.invalidateQueries({ queryKey: ['quotation', q.quotationId] });
      onSaved(q.quotationId);
    },
    onError: (err) => {
      // Surface Zod validation detail if present, otherwise fall back to
      // the generic error string. The API returns { success:false,
      // error:{message, details:[{path, message}, ...]} } — the axios
      // error object exposes response.data.error.details.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const details = (err as any)?.response?.data?.error?.details as { path?: string[]; message?: string }[] | undefined;
      if (Array.isArray(details) && details.length) {
        const lines = details.slice(0, 4).map((d) => {
          const path = Array.isArray(d.path) ? d.path.join('.') : '';
          return path ? `${path}: ${d.message}` : d.message;
        });
        toast.error(`Validation failed:\n${lines.join('\n')}`, { duration: 6000 });
      } else {
        toast.error(getErrorMessage(err));
      }
    },
  });

  const setField = <K extends keyof CreateQuotationInput>(k: K, v: CreateQuotationInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const addItem = (kind: 'per_cylinder' | 'per_kg') => {
    const newItem: QuotationItemInput = kind === 'per_cylinder'
      ? { kind: 'per_cylinder', itemName: '', hsnCode: '27111900', priceInclGst: 0, discountInclGst: 0 }
      : { kind: 'per_kg', itemName: '', hsnCode: '27111900', cylinderCapacityKg: 19, pricePerKgInclGst: 0, discountPerKgInclGst: 0 };
    setForm((f) => ({ ...f, items: [...f.items, newItem] }));
  };
  const removeItem = (idx: number) => setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
  const updateItem = (idx: number, patch: Partial<QuotationItemInput>) =>
    setForm((f) => ({
      ...f,
      items: f.items.map((it, i) =>
        i === idx ? ({ ...it, ...patch } as QuotationItemInput) : it,
      ),
    }));

  const canSave = form.subject.trim().length > 0
    && form.recipientName.trim().length > 0
    && form.recipientEmail.trim().length > 0
    && form.items.length > 0
    && !saveMutation.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <HiOutlineArrowLeft className="h-4 w-4" /> Back
        </Button>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">
          {isEdit ? `Edit ${existingQuery.data?.quotationNumber ?? 'quotation'}` : 'New quotation'}
        </h1>
      </div>

      {/* ── Recipient ──────────────────────────────────────────────── */}
      <div className="card p-4 space-y-3">
        <h2 className="font-semibold">Recipient</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select
            label="Existing customer (optional)"
            value={selectedCustomerId}
            onChange={(e) => applyCustomerPrefill(e.target.value)}
            options={[
              { value: '', label: 'Freeform lead — type details below' },
              ...customers.map((c) => ({ value: c.customerId, label: c.customerName })),
            ]}
          />
          <div />
          <Input label="Recipient name" required value={form.recipientName}
            onChange={(e) => setField('recipientName', e.target.value)} />
          <Input label="Contact person" value={form.recipientContactPerson ?? ''}
            onChange={(e) => setField('recipientContactPerson', e.target.value)} />
          <Input label="Email (primary)" required type="email" value={form.recipientEmail}
            onChange={(e) => setField('recipientEmail', e.target.value)} />
          <Input label="Phone" value={form.recipientPhone ?? ''}
            onChange={(e) => setField('recipientPhone', e.target.value)} />
          <div className="sm:col-span-2">
            <Input
              label="CC (comma-separated, optional)"
              placeholder="finance@customer.com, procurement@customer.com"
              value={(form.ccEmails ?? []).join(', ')}
              onChange={(e) => {
                // Split on comma OR semicolon, strip whitespace, drop empties.
                const list = e.target.value
                  .split(/[,;]+/)
                  .map((s) => s.trim())
                  .filter(Boolean);
                setField('ccEmails', list);
              }}
            />
            <p className="text-xs text-surface-400 mt-1">
              Up to 10 CCs. All get the email + PDF; only the primary is shown on the &ldquo;Quotation To&rdquo; block of the PDF.
            </p>
          </div>
          <Input label="Address" value={form.recipientAddress ?? ''}
            onChange={(e) => setField('recipientAddress', e.target.value)} />
          <div className="grid grid-cols-3 gap-2">
            <Input label="City" value={form.recipientCity ?? ''}
              onChange={(e) => setField('recipientCity', e.target.value)} />
            <Input label="State" value={form.recipientState ?? ''}
              onChange={(e) => setField('recipientState', e.target.value)} />
            <Input label="Pincode" value={form.recipientPincode ?? ''}
              onChange={(e) => setField('recipientPincode', e.target.value)} />
          </div>
          <Input label="GSTIN (optional)" value={form.recipientGstin ?? ''}
            onChange={(e) => setField('recipientGstin', e.target.value)} />
        </div>
      </div>

      {/* ── Meta / Subject / Cover ─────────────────────────────────── */}
      <div className="card p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Input label="Quotation date" required type="date" value={form.quotationDate}
            onChange={(e) => setField('quotationDate', e.target.value)} />
          <Input label="Valid until" required type="date" value={form.validUntil}
            onChange={(e) => setField('validUntil', e.target.value)} />
          <Select label="GST rate" value={String(form.gstRate)}
            onChange={(e) => setField('gstRate', Number(e.target.value) as typeof form.gstRate)}
            options={QUOTATION_GST_RATES.map((r) => ({ value: String(r), label: `${(r * 100).toFixed(0)}%` }))} />
        </div>
        <Select label="Credit terms" value={form.creditTerms}
          onChange={(e) => setField('creditTerms', e.target.value)}
          options={[
            { value: '', label: '— pick —' },
            ...QUOTATION_CREDIT_TERMS_PRESETS.map((c) => ({ value: c, label: c })),
            { value: form.creditTerms && !QUOTATION_CREDIT_TERMS_PRESETS.includes(form.creditTerms as typeof QUOTATION_CREDIT_TERMS_PRESETS[number]) ? form.creditTerms : '__custom__', label: 'Custom (type below)' },
          ]} />
        {(form.creditTerms === '__custom__' || (form.creditTerms && !QUOTATION_CREDIT_TERMS_PRESETS.includes(form.creditTerms as typeof QUOTATION_CREDIT_TERMS_PRESETS[number]))) && (
          <Input label="Custom credit terms" value={form.creditTerms === '__custom__' ? '' : form.creditTerms}
            onChange={(e) => setField('creditTerms', e.target.value)} />
        )}
        <Input label="Subject" required value={form.subject}
          onChange={(e) => setField('subject', e.target.value)} />
        <div>
          <label className="text-sm font-medium text-surface-700 dark:text-surface-200">Cover message *</label>
          <textarea
            className="w-full mt-1 rounded-md border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 px-3 py-2 text-sm"
            rows={5} value={form.coverText}
            onChange={(e) => setField('coverText', e.target.value)}
          />
        </div>
      </div>

      {/* ── Line items ────────────────────────────────────────────── */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Line items</h2>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => addItem('per_cylinder')}>
              <HiOutlinePlus className="h-4 w-4" /> Per-cylinder row
            </Button>
            <Button variant="secondary" size="sm" onClick={() => addItem('per_kg')}>
              <HiOutlinePlus className="h-4 w-4" /> Per-KG row
            </Button>
          </div>
        </div>
        {form.items.length === 0 ? (
          <p className="text-sm italic text-surface-400">Add at least one line item.</p>
        ) : form.items.map((it, idx) => (
          <ItemEditor
            key={idx}
            item={it}
            index={idx}
            types={cylinderTypes}
            latestPriceByTypeId={latestPriceByTypeId}
            gstRate={form.gstRate}
            onChange={(patch) => updateItem(idx, patch)}
            onRemove={() => removeItem(idx)}
          />
        ))}
      </div>

      {/* ── Terms + footer ────────────────────────────────────────── */}
      <div className="card p-4 space-y-3">
        <div>
          <label className="text-sm font-medium text-surface-700 dark:text-surface-200">Terms & conditions (one per line)</label>
          <textarea
            className="w-full mt-1 rounded-md border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 px-3 py-2 text-sm"
            rows={6}
            value={form.terms.join('\n')}
            onChange={(e) => setField('terms', e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
          />
        </div>
        <Input label="Footer notes (optional)" value={form.footerNotes ?? ''}
          onChange={(e) => setField('footerNotes', e.target.value)} />
      </div>

      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={onBack}>Cancel</Button>
        <Button onClick={() => saveMutation.mutate(form)} disabled={!canSave} loading={saveMutation.isPending}>
          {isEdit ? 'Save draft' : 'Save + preview'}
        </Button>
      </div>
    </div>
  );
}

function defaultForm(today: string): CreateQuotationInput {
  const dt = new Date();
  dt.setDate(dt.getDate() + 30);
  const validUntil = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  return {
    quotationDate: today,
    validUntil,
    customerId: null,
    recipientName: '',
    recipientEmail: '',
    ccEmails: [],
    subject: '',
    coverText: 'Dear Sir / Madam,\n\nThank you for the opportunity. Please find our rates below.\n\nRegards.',
    terms: DEFAULT_TERMS,
    creditTerms: QUOTATION_CREDIT_TERMS_PRESETS[3],
    gstRate: 0.05,
    items: [],
  };
}

/** Numeric input that avoids the "0-prefix" UX by storing the raw string
 *  and only converting on blur / commit. Empty is stored as 0 upstream. */
function NumericInput({
  label, value, onCommit, step = '0.01',
}: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
  step?: string;
}) {
  // Track local string so the user can type freely (including leading
  // decimal, empty, etc.) without React clobbering it back to "0.0".
  const [local, setLocal] = useState<string>(() => value === 0 ? '' : String(value));
  // When the parent value changes externally (auto-fill), reflect it.
  useEffect(() => {
    const asNum = local === '' ? 0 : Number(local);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (asNum !== value) setLocal(value === 0 ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Input
      label={label}
      type="number"
      inputMode="decimal"
      step={step}
      value={local}
      onChange={(e) => {
        setLocal(e.target.value);
        // Commit as we type — but only pass the numeric interpretation.
        onCommit(e.target.value === '' ? 0 : Number(e.target.value));
      }}
      onBlur={() => {
        // Normalise on blur so "0" and "05" both become "5".
        if (local !== '' && !Number.isNaN(Number(local))) {
          setLocal(String(Number(local)));
        }
      }}
    />
  );
}

function ItemEditor({
  item, index, types, latestPriceByTypeId, gstRate, onChange, onRemove,
}: {
  item: QuotationItemInput;
  index: number;
  types: CylinderTypeLite[];
  latestPriceByTypeId: Map<string, number>;
  gstRate: number;
  onChange: (patch: Partial<QuotationItemInput>) => void;
  onRemove: () => void;
}) {
  // Derived preview so the user sees "final billable" as they type.
  const preview = (() => {
    if (item.kind === 'per_cylinder') {
      const price = item.priceInclGst || 0;
      const disc = item.discountInclGst || 0;
      const final = price - disc;
      return `Final rate: ${inr.format(final)} incl. GST · Basic (pre-GST): ${inr.format(price / (1 + gstRate))}`;
    }
    const price = item.pricePerKgInclGst || 0;
    const disc = item.discountPerKgInclGst || 0;
    const final = price - disc;
    return `Final rate per KG: ${inr.format(final)} incl. GST · Basic per KG: ${inr.format(price / (1 + gstRate))}`;
  })();

  return (
    <div className="border border-surface-200 dark:border-surface-700 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-surface-500">#{index + 1} · {item.kind === 'per_cylinder' ? 'PER-CYLINDER' : 'PER-KG'}</span>
        <Button variant="ghost" size="sm" onClick={onRemove}>
          <HiOutlineTrash className="h-4 w-4 text-red-500" />
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Select
          label="Cylinder type"
          value={item.cylinderTypeId ?? ''}
          onChange={(e) => {
            const id = e.target.value || null;
            const t = types.find((tt) => tt.cylinderTypeId === id);
            const catalogPrice = id ? latestPriceByTypeId.get(id) : undefined;
            if (item.kind === 'per_kg') {
              // Auto-fill: for per-KG mode, seed the per-KG rate = catalog
              // price ÷ capacity. User can override.
              const perKgSeed = catalogPrice && t?.capacity ? catalogPrice / t.capacity : item.pricePerKgInclGst;
              onChange({
                cylinderTypeId: id,
                itemName: t?.typeName ?? item.itemName,
                hsnCode: t?.hsnCode ?? item.hsnCode,
                cylinderCapacityKg: t?.capacity ?? item.cylinderCapacityKg,
                pricePerKgInclGst: perKgSeed,
              } as Partial<QuotationItemInput>);
            } else {
              // Per-cylinder mode: seed price directly from the catalog.
              onChange({
                cylinderTypeId: id,
                itemName: t?.typeName ?? item.itemName,
                hsnCode: t?.hsnCode ?? item.hsnCode,
                priceInclGst: catalogPrice ?? item.priceInclGst,
              } as Partial<QuotationItemInput>);
            }
          }}
          options={[
            { value: '', label: '— none (typed below) —' },
            ...types.map((t) => {
              const p = latestPriceByTypeId.get(t.cylinderTypeId);
              return { value: t.cylinderTypeId, label: p ? `${t.typeName} (Rs. ${p.toFixed(2)})` : t.typeName };
            }),
          ]}
        />
        <Input label="Item name" value={item.itemName}
          onChange={(e) => onChange({ itemName: e.target.value } as Partial<QuotationItemInput>)} />
        <Input label="HSN" value={item.hsnCode}
          onChange={(e) => onChange({ hsnCode: e.target.value } as Partial<QuotationItemInput>)} />
      </div>
      {item.kind === 'per_cylinder' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <NumericInput label="Rate per cylinder (incl. GST)"
            value={item.priceInclGst}
            onCommit={(n) => onChange({ priceInclGst: n } as Partial<QuotationItemInput>)} />
          <NumericInput label="Discount per cylinder (incl. GST)"
            value={item.discountInclGst}
            onCommit={(n) => onChange({ discountInclGst: n } as Partial<QuotationItemInput>)} />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <NumericInput label="Cylinder capacity (KG)" step="0.1"
            value={item.cylinderCapacityKg}
            onCommit={(n) => onChange({ cylinderCapacityKg: n } as Partial<QuotationItemInput>)} />
          <NumericInput label="Rate per KG (incl. GST)"
            value={item.pricePerKgInclGst}
            onCommit={(n) => onChange({ pricePerKgInclGst: n } as Partial<QuotationItemInput>)} />
          <NumericInput label="Discount per KG (incl. GST)"
            value={item.discountPerKgInclGst}
            onCommit={(n) => onChange({ discountPerKgInclGst: n } as Partial<QuotationItemInput>)} />
        </div>
      )}
      <p className="text-xs text-surface-500 italic">{preview}</p>
    </div>
  );
}

// ─── VIEW ─────────────────────────────────────────────────────────────────

function QuotationView({
  quotationId, onBack, onEdit,
}: {
  quotationId: string;
  onBack: () => void;
  onEdit: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['quotation', quotationId],
    queryFn: () => apiGet<Quotation>(`/quotations/${quotationId}`),
  });
  const q = query.data;

  const [downloading, setDownloading] = useState(false);
  const handleDownload = async () => {
    setDownloading(true);
    try {
      const resp = await api.get(`/quotations/${quotationId}/pdf`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${q?.quotationNumber ?? 'quotation'}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  // Fallback when server-side SMTP isn't available. Two modes:
  //   'gmail' — opens Gmail's web compose in a new tab. Works reliably in
  //             Chrome without needing a registered mailto: handler (which
  //             is what caused the earlier "nothing happens" symptom).
  //   'mailto' — the OS default mail-client protocol. Use this for
  //              Outlook / Apple Mail / etc.
  // Both routes pre-fill To + Subject + Body from the quote's cover text.
  // Neither can attach the PDF programmatically — the user hits Download
  // PDF separately and attaches it in their compose window.
  const openMailComposer = (mode: 'gmail' | 'mailto' = 'gmail') => {
    if (!q) return;
    const subject = encodeURIComponent(q.subject);
    const body = encodeURIComponent(
      `${q.coverText}\n\n` +
      `Please find the attached quotation ${q.quotationNumber} valid until ${q.validUntil}.\n\n` +
      `Regards.`,
    );
    const href = mode === 'gmail'
      ? `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(q.recipientEmail)}&su=${subject}&body=${body}`
      : `mailto:${q.recipientEmail}?subject=${subject}&body=${body}`;
    window.open(href, '_blank', 'noopener');
    toast('Download the PDF and attach it in the compose window before sending.', { duration: 6000 });
  };

  const [sending, setSending] = useState(false);
  const sendMutation = useMutation({
    mutationFn: () => apiPost<{ sent: boolean; reason?: string; error?: string; quotation: Quotation }>(
      `/quotations/${quotationId}/send-email`, {},
    ),
    onMutate: () => setSending(true),
    onSettled: () => setSending(false),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['quotation', quotationId] });
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      if (result.sent) {
        toast.success(`Quotation emailed to ${q?.recipientEmail} with the PDF attached`);
      } else if (result.reason === 'skipped') {
        toast(
          'SMTP not configured — opening Gmail compose instead. Attach the downloaded PDF manually.',
          { duration: 6000 },
        );
        openMailComposer('gmail');
      } else {
        toast.error(`SMTP send failed: ${result.error ?? 'unknown error'}. Click "Open in Gmail" to send manually.`);
      }
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const statusMut = (endpoint: 'mark-sent' | 'mark-accepted' | 'mark-rejected') => async () => {
    try {
      await apiPost<Quotation>(`/quotations/${quotationId}/${endpoint}`, {});
      queryClient.invalidateQueries({ queryKey: ['quotation', quotationId] });
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      toast.success('Status updated');
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const duplicateMutation = useMutation({
    mutationFn: () => apiPost<Quotation>(`/quotations/${quotationId}/duplicate`, {}),
    onSuccess: (clone) => {
      toast.success(`Duplicated as ${clone.quotationNumber} — edit prices now`);
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
      onEdit(clone.quotationId);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  if (query.isLoading || !q) return <div className="flex justify-center py-16"><Loader /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <HiOutlineArrowLeft className="h-4 w-4" /> Back
        </Button>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">{q.quotationNumber}</h1>
        <Badge>{STATUS_LABELS[q.status]}</Badge>
        {q.duplicateFromNumber && (
          <span className="text-xs text-surface-500">Duplicated from {q.duplicateFromNumber}</span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={handleDownload} loading={downloading}>
          <HiOutlineArrowDownTray className="h-4 w-4" /> Download PDF
        </Button>
        {(q.status === 'draft' || q.status === 'sent') && (
          <Button onClick={() => sendMutation.mutate()} loading={sending} title={`Send to ${q.recipientEmail} with PDF attached`}>
            <HiOutlinePaperAirplane className="h-4 w-4" />
            {q.status === 'sent' ? 'Re-send via email' : 'Send via email'}
          </Button>
        )}
        <Button variant="secondary" onClick={() => openMailComposer('gmail')} title="Open Gmail compose in a new tab (works without a mailto handler)">
          <HiOutlinePaperAirplane className="h-4 w-4" /> Open in Gmail
        </Button>
        <Button variant="ghost" size="sm" onClick={() => openMailComposer('mailto')} title="Try the OS default mail app (Outlook, Apple Mail, etc)">
          <HiOutlinePaperAirplane className="h-3 w-3" /> Default mail app
        </Button>
        {q.status === 'draft' && (
          <>
            <Button variant="secondary" onClick={() => onEdit(q.quotationId)}>
              <HiOutlinePencilSquare className="h-4 w-4" /> Edit
            </Button>
            <Button variant="secondary" onClick={statusMut('mark-sent')} title="Mark as sent without emailing (already sent out-of-band)">
              <HiOutlineCheckCircle className="h-4 w-4" /> Mark as sent
            </Button>
          </>
        )}
        {/* Mark accepted / rejected hidden per user feedback — most users
            won't track quote outcome that granularly. Endpoints + status
            enum remain in place so this can come back later. */}
        <Button variant="secondary" onClick={() => duplicateMutation.mutate()}>
          <HiOutlineDocumentDuplicate className="h-4 w-4" /> Duplicate for a new month
        </Button>
      </div>

      <div className="card p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-surface-500 uppercase">Quotation to</div>
          <div className="font-semibold">{q.recipientName}</div>
          {q.recipientContactPerson && <div className="text-sm">Attn: {q.recipientContactPerson}</div>}
          <div className="text-sm text-surface-500">{q.recipientAddress}</div>
          <div className="text-sm text-surface-500">
            {[q.recipientCity, q.recipientState, q.recipientPincode].filter(Boolean).join(', ')}
          </div>
          <div className="text-sm mt-1">Email: {q.recipientEmail}</div>
          {q.ccEmails && q.ccEmails.length > 0 && (
            <div className="text-sm text-surface-500">CC: {q.ccEmails.join(', ')}</div>
          )}
          {q.recipientPhone && <div className="text-sm">Phone: {q.recipientPhone}</div>}
          {q.recipientGstin && <div className="text-sm font-semibold">GSTIN: {q.recipientGstin}</div>}
        </div>
        <div className="text-sm space-y-1">
          <div><span className="text-surface-500">Date:</span> {q.quotationDate}</div>
          <div><span className="text-surface-500">Valid until:</span> {q.validUntil}</div>
          <div><span className="text-surface-500">Credit terms:</span> {q.creditTerms}</div>
          <div><span className="text-surface-500">GST rate:</span> {(q.gstRate * 100).toFixed(0)}%</div>
          <div><span className="text-surface-500">Mode:</span> {q.mode}</div>
        </div>
      </div>

      <div className="card p-4">
        <div className="text-xs text-surface-500 uppercase">Subject</div>
        <div className="font-semibold text-primary-700 dark:text-primary-300 mb-3">{q.subject}</div>
        <div className="text-sm whitespace-pre-wrap">{q.coverText}</div>
      </div>

      <div className="card p-4">
        <div className="text-xs text-surface-500 uppercase mb-2">Line items</div>
        <div className="space-y-2">
          {q.items.map((it) => {
            if (it.kind === 'per_cylinder') {
              const price = it.priceInclGst ?? 0;
              const disc = it.discountInclGst ?? 0;
              const final = price - disc;
              return (
                <div key={it.quotationItemId} className="border-b border-surface-100 dark:border-surface-800 pb-2 text-sm">
                  <div className="font-medium">{it.itemName} <span className="text-xs text-surface-400">· HSN {it.hsnCode}</span></div>
                  <div className="text-xs text-surface-500">
                    Rate {inr.format(price)} (incl GST) · Discount {inr.format(disc)} · Final {inr.format(final)}
                  </div>
                </div>
              );
            }
            const price = it.pricePerKgInclGst ?? 0;
            const disc = it.discountPerKgInclGst ?? 0;
            const basicPerKg = price / (1 + q.gstRate);
            const final = price - disc;
            return (
              <div key={it.quotationItemId} className="border-b border-surface-100 dark:border-surface-800 pb-2 text-sm">
                <div className="font-medium">{it.itemName} <span className="text-xs text-surface-400">· HSN {it.hsnCode}</span></div>
                <div className="text-xs text-surface-500">
                  Rate/KG {inr.format(price)} incl GST (Basic {inr.format(basicPerKg)}) · Discount/KG {inr.format(disc)} · Final/KG {inr.format(final)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card p-4">
        <div className="text-xs text-surface-500 uppercase mb-2">Terms & conditions</div>
        <ol className="text-sm list-decimal ml-5 space-y-1">
          {q.terms.map((t, i) => (<li key={i}>{t}</li>))}
        </ol>
      </div>
    </div>
  );
}
