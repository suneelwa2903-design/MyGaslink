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
  HiOutlineEye, HiOutlineCheckCircle, HiOutlineXCircle,
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
interface CustomerLite { id: string; customerName: string; gstin: string | null; phone: string | null }
interface CylinderTypeLite { id: string; typeName: string; capacity: number; hsnCode: string }

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

  const customers = customersQuery.data?.customers ?? [];
  const cylinderTypes = typesQuery.data?.cylinderTypes ?? [];

  // Form state — plain useState rather than react-hook-form because
  // the dynamic item list is easier to manage manually.
  const [form, setForm] = useState<CreateQuotationInput>(() => defaultForm(today));
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');

  // Populate from existing draft
  useEffect(() => {
    if (isEdit && existingQuery.data) {
      const q = existingQuery.data;
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
                unitPrice: it.unitPrice ?? 0,
                discountPerUnit: it.discountPerUnit ?? 0,
                sortOrder: it.sortOrder,
                notes: it.notes ?? undefined,
              }
            : {
                kind: 'per_kg',
                cylinderTypeId: it.cylinderTypeId,
                itemName: it.itemName,
                hsnCode: it.hsnCode,
                cylinderCapacityKg: it.cylinderCapacityKg ?? 0,
                basicPricePerKg: it.basicPricePerKg ?? 0,
                discountPerKg: it.discountPerKg ?? 0,
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
    const c = customers.find((cc) => cc.id === customerId);
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
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const setField = <K extends keyof CreateQuotationInput>(k: K, v: CreateQuotationInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const addItem = (kind: 'per_cylinder' | 'per_kg') => {
    const newItem: QuotationItemInput = kind === 'per_cylinder'
      ? { kind: 'per_cylinder', itemName: '', hsnCode: '27111900', unitPrice: 0, discountPerUnit: 0 }
      : { kind: 'per_kg', itemName: '', hsnCode: '27111900', cylinderCapacityKg: 19, basicPricePerKg: 0, discountPerKg: 0 };
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
              ...customers.map((c) => ({ value: c.id, label: c.customerName })),
            ]}
          />
          <div />
          <Input label="Recipient name" required value={form.recipientName}
            onChange={(e) => setField('recipientName', e.target.value)} />
          <Input label="Contact person" value={form.recipientContactPerson ?? ''}
            onChange={(e) => setField('recipientContactPerson', e.target.value)} />
          <Input label="Email" required type="email" value={form.recipientEmail}
            onChange={(e) => setField('recipientEmail', e.target.value)} />
          <Input label="Phone" value={form.recipientPhone ?? ''}
            onChange={(e) => setField('recipientPhone', e.target.value)} />
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
    subject: '',
    coverText: 'Dear Sir / Madam,\n\nThank you for the opportunity. Please find our rates below.\n\nRegards.',
    terms: DEFAULT_TERMS,
    creditTerms: QUOTATION_CREDIT_TERMS_PRESETS[3],
    gstRate: 0.05,
    items: [],
  };
}

function ItemEditor({
  item, index, types, onChange, onRemove,
}: {
  item: QuotationItemInput;
  index: number;
  types: CylinderTypeLite[];
  onChange: (patch: Partial<QuotationItemInput>) => void;
  onRemove: () => void;
}) {
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
          label="Cylinder type (optional link)"
          value={item.cylinderTypeId ?? ''}
          onChange={(e) => {
            const id = e.target.value || null;
            const t = types.find((tt) => tt.id === id);
            if (item.kind === 'per_kg') {
              onChange({
                cylinderTypeId: id,
                itemName: t?.typeName ?? item.itemName,
                hsnCode: t?.hsnCode ?? item.hsnCode,
                cylinderCapacityKg: t?.capacity ?? item.cylinderCapacityKg,
              } as Partial<QuotationItemInput>);
            } else {
              onChange({
                cylinderTypeId: id,
                itemName: t?.typeName ?? item.itemName,
                hsnCode: t?.hsnCode ?? item.hsnCode,
              } as Partial<QuotationItemInput>);
            }
          }}
          options={[{ value: '', label: '— none —' }, ...types.map((t) => ({ value: t.id, label: t.typeName }))]}
        />
        <Input label="Item name" value={item.itemName}
          onChange={(e) => onChange({ itemName: e.target.value } as Partial<QuotationItemInput>)} />
        <Input label="HSN" value={item.hsnCode}
          onChange={(e) => onChange({ hsnCode: e.target.value } as Partial<QuotationItemInput>)} />
      </div>
      {item.kind === 'per_cylinder' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Input label="Rate per cylinder (basic, pre-GST)" type="number" step="0.01"
            value={item.unitPrice}
            onChange={(e) => onChange({ unitPrice: Number(e.target.value) } as Partial<QuotationItemInput>)} />
          <Input label="Discount per cylinder (pre-GST)" type="number" step="0.01"
            value={item.discountPerUnit}
            onChange={(e) => onChange({ discountPerUnit: Number(e.target.value) } as Partial<QuotationItemInput>)} />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Input label="Cylinder capacity (KG)" type="number" step="0.1"
            value={item.cylinderCapacityKg}
            onChange={(e) => onChange({ cylinderCapacityKg: Number(e.target.value) } as Partial<QuotationItemInput>)} />
          <Input label="Basic price per KG (pre-GST)" type="number" step="0.01"
            value={item.basicPricePerKg}
            onChange={(e) => onChange({ basicPricePerKg: Number(e.target.value) } as Partial<QuotationItemInput>)} />
          <Input label="Discount per KG" type="number" step="0.01"
            value={item.discountPerKg}
            onChange={(e) => onChange({ discountPerKg: Number(e.target.value) } as Partial<QuotationItemInput>)} />
        </div>
      )}
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

  const emailIt = () => {
    if (!q) return;
    const subject = encodeURIComponent(q.subject);
    const body = encodeURIComponent(
      `${q.coverText}\n\n` +
      `Please find the attached quotation ${q.quotationNumber} valid until ${q.validUntil}.\n\n` +
      `Regards.`,
    );
    window.location.href = `mailto:${q.recipientEmail}?subject=${subject}&body=${body}`;
  };

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
        <Button variant="secondary" onClick={emailIt}>
          <HiOutlinePaperAirplane className="h-4 w-4" /> Open in email
        </Button>
        {q.status === 'draft' && (
          <>
            <Button variant="secondary" onClick={() => onEdit(q.quotationId)}>
              <HiOutlinePencilSquare className="h-4 w-4" /> Edit
            </Button>
            <Button variant="secondary" onClick={statusMut('mark-sent')}>
              <HiOutlinePaperAirplane className="h-4 w-4" /> Mark as sent
            </Button>
          </>
        )}
        {(q.status === 'draft' || q.status === 'sent') && (
          <>
            <Button variant="secondary" onClick={statusMut('mark-accepted')}>
              <HiOutlineCheckCircle className="h-4 w-4" /> Mark accepted
            </Button>
            <Button variant="secondary" onClick={statusMut('mark-rejected')}>
              <HiOutlineXCircle className="h-4 w-4" /> Mark rejected
            </Button>
          </>
        )}
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
              const netBasic = (it.unitPrice ?? 0) - (it.discountPerUnit ?? 0);
              const inclGst = netBasic * (1 + q.gstRate);
              return (
                <div key={it.quotationItemId} className="border-b border-surface-100 dark:border-surface-800 pb-2 text-sm">
                  <div className="font-medium">{it.itemName} <span className="text-xs text-surface-400">· HSN {it.hsnCode}</span></div>
                  <div className="text-xs text-surface-500">
                    Rate {inr.format(it.unitPrice ?? 0)} · Discount {inr.format(it.discountPerUnit ?? 0)} · Incl. GST {inr.format(inclGst)}
                  </div>
                </div>
              );
            }
            const rspPerKg = (it.basicPricePerKg ?? 0) * (1 + q.gstRate);
            const netBasic = (it.basicPricePerKg ?? 0) - (it.discountPerKg ?? 0);
            const inclGst = netBasic * (1 + q.gstRate);
            return (
              <div key={it.quotationItemId} className="border-b border-surface-100 dark:border-surface-800 pb-2 text-sm">
                <div className="font-medium">{it.itemName} <span className="text-xs text-surface-400">· HSN {it.hsnCode}</span></div>
                <div className="text-xs text-surface-500">
                  Rate/KG {inr.format(it.basicPricePerKg ?? 0)} (RSP {inr.format(rspPerKg)}) · Discount/KG {inr.format(it.discountPerKg ?? 0)} · Incl. GST/KG {inr.format(inclGst)}
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
