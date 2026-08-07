/**
 * Report Builder page (Phase 2 · 2026-08-05).
 *
 * A minimal-yet-solid form-based builder — the user picks a model,
 * checks the fields they want, optionally adds filters + grouping +
 * aggregations, previews live, and saves.
 *
 * Route: /app/report-builder            → New (blank spec)
 * Route: /app/report-builder/:id        → Edit an existing saved report
 *
 * Design principle (per Suneel): no SQL text ever. Every choice is a
 * dropdown / checkbox / typed value. Server-side allowlist decides
 * what shows up in the field checklist.
 */

import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { HiOutlineArrowLeft, HiOutlineTrash, HiOutlinePlus } from 'react-icons/hi2';
import { apiGet, apiPost, apiPut, apiDelete, getErrorMessage } from '@/lib/api';
import { Button, Loader, Select, Modal, EmptyState } from '@/components/ui';
import type {
  ReportBuilderModel,
  ReportBuilderSpec,
  ReportBuilderFilter,
  ReportBuilderAggregate,
  ReportBuilderOp,
  ReportBuilderDatePreset,
  SavedReportDto,
  SavedReportRunResult,
} from '@gaslink/shared';

// ─── Model → available fields (client-side hint only; server is authoritative) ─
//
// This mirrors the SERVER allowlist but only shows to the user what's
// visible for common tasks. Server rejects anything not in its own
// allowlist regardless of what UI hints at, so this is safe to keep
// generous.

const MODEL_LABELS: Record<ReportBuilderModel, string> = {
  Order: 'Orders',
  Invoice: 'Invoices',
  PaymentTransaction: 'Payments',
  CustomerLedgerEntry: 'Customer Ledger Entries',
  Expense: 'Expenses',
  PurchaseEntry: 'Purchases (from OMC)',
};

interface FieldSpec { key: string; label: string; type: 'string' | 'number' | 'date' | 'enum'; groupable: boolean; aggregatable: boolean; }

const FIELDS_BY_MODEL: Record<ReportBuilderModel, FieldSpec[]> = {
  Order: [
    { key: 'orderNumber', label: 'Order Number', type: 'string', groupable: false, aggregatable: false },
    { key: 'orderDate', label: 'Order Date', type: 'date', groupable: true, aggregatable: false },
    { key: 'deliveryDate', label: 'Delivery Date', type: 'date', groupable: true, aggregatable: false },
    { key: 'status', label: 'Status', type: 'enum', groupable: true, aggregatable: false },
    { key: 'tripNumber', label: 'Trip Number', type: 'number', groupable: true, aggregatable: false },
    { key: 'poNumber', label: 'PO Number', type: 'string', groupable: false, aggregatable: false },
    { key: 'customer.customerName', label: 'Customer', type: 'string', groupable: false, aggregatable: false },
    { key: 'driver.driverName', label: 'Driver', type: 'string', groupable: false, aggregatable: false },
    { key: 'vehicle.vehicleNumber', label: 'Vehicle', type: 'string', groupable: false, aggregatable: false },
    { key: 'totalAmount', label: 'Total Amount (₹)', type: 'number', groupable: false, aggregatable: true },
  ],
  Invoice: [
    { key: 'invoiceNumber', label: 'Invoice Number', type: 'string', groupable: false, aggregatable: false },
    { key: 'issueDate', label: 'Issue Date', type: 'date', groupable: true, aggregatable: false },
    { key: 'dueDate', label: 'Due Date', type: 'date', groupable: true, aggregatable: false },
    { key: 'status', label: 'Status', type: 'enum', groupable: true, aggregatable: false },
    { key: 'customer.customerName', label: 'Customer', type: 'string', groupable: false, aggregatable: false },
    { key: 'isOpeningBalance', label: 'Opening Balance?', type: 'enum', groupable: true, aggregatable: false },
    { key: 'totalAmount', label: 'Total Amount (₹)', type: 'number', groupable: false, aggregatable: true },
    { key: 'amountPaid', label: 'Amount Paid (₹)', type: 'number', groupable: false, aggregatable: true },
    { key: 'outstandingAmount', label: 'Outstanding (₹)', type: 'number', groupable: false, aggregatable: true },
    { key: 'cgstValue', label: 'CGST (₹)', type: 'number', groupable: false, aggregatable: true },
    { key: 'sgstValue', label: 'SGST (₹)', type: 'number', groupable: false, aggregatable: true },
    { key: 'igstValue', label: 'IGST (₹)', type: 'number', groupable: false, aggregatable: true },
  ],
  PaymentTransaction: [
    { key: 'transactionDate', label: 'Transaction Date', type: 'date', groupable: true, aggregatable: false },
    { key: 'paymentMethod', label: 'Method', type: 'enum', groupable: true, aggregatable: false },
    { key: 'referenceNumber', label: 'Reference #', type: 'string', groupable: false, aggregatable: false },
    { key: 'notes', label: 'Notes', type: 'string', groupable: false, aggregatable: false },
    { key: 'allocationStatus', label: 'Allocation Status', type: 'enum', groupable: true, aggregatable: false },
    { key: 'customer.customerName', label: 'Customer', type: 'string', groupable: false, aggregatable: false },
    { key: 'amount', label: 'Amount (₹)', type: 'number', groupable: false, aggregatable: true },
  ],
  CustomerLedgerEntry: [
    { key: 'entryDate', label: 'Entry Date', type: 'date', groupable: true, aggregatable: false },
    { key: 'entryType', label: 'Entry Type', type: 'enum', groupable: true, aggregatable: false },
    { key: 'narration', label: 'Narration', type: 'string', groupable: false, aggregatable: false },
    { key: 'voucherNumber', label: 'Voucher #', type: 'string', groupable: false, aggregatable: false },
    { key: 'customer.customerName', label: 'Customer', type: 'string', groupable: false, aggregatable: false },
    { key: 'cylinderType.typeName', label: 'Cylinder Type', type: 'string', groupable: false, aggregatable: false },
    { key: 'qtyDelta', label: 'Qty Change', type: 'number', groupable: false, aggregatable: true },
    { key: 'amountDelta', label: 'Amount Change (₹)', type: 'number', groupable: false, aggregatable: true },
  ],
  Expense: [
    { key: 'expenseDate', label: 'Expense Date', type: 'date', groupable: true, aggregatable: false },
    { key: 'description', label: 'Description', type: 'string', groupable: false, aggregatable: false },
    { key: 'paymentMethod', label: 'Method', type: 'enum', groupable: true, aggregatable: false },
    { key: 'vendorName', label: 'Vendor', type: 'string', groupable: false, aggregatable: false },
    { key: 'paidToName', label: 'Paid To', type: 'string', groupable: false, aggregatable: false },
    { key: 'referenceNumber', label: 'Ref #', type: 'string', groupable: false, aggregatable: false },
    { key: 'category.name', label: 'Category', type: 'string', groupable: false, aggregatable: false },
    { key: 'vehicle.vehicleNumber', label: 'Vehicle', type: 'string', groupable: false, aggregatable: false },
    { key: 'driver.driverName', label: 'Driver', type: 'string', groupable: false, aggregatable: false },
    { key: 'amount', label: 'Amount (₹)', type: 'number', groupable: false, aggregatable: true },
  ],
  PurchaseEntry: [
    { key: 'purchaseNumber', label: 'Purchase Number', type: 'string', groupable: false, aggregatable: false },
    { key: 'purchaseDate', label: 'Purchase Date', type: 'date', groupable: true, aggregatable: false },
    { key: 'notes', label: 'Notes', type: 'string', groupable: false, aggregatable: false },
    { key: 'sourceDistributor.name', label: 'Supplier', type: 'string', groupable: false, aggregatable: false },
    { key: 'isOpeningBalance', label: 'Opening Balance?', type: 'enum', groupable: true, aggregatable: false },
    { key: 'amountPaid', label: 'Amount Paid (₹)', type: 'number', groupable: false, aggregatable: true },
  ],
};

const OP_LABELS: Record<ReportBuilderOp, string> = {
  eq: 'equals', neq: 'not equals',
  gt: 'greater than', gte: 'greater than or equal',
  lt: 'less than', lte: 'less than or equal',
  in: 'is one of', not_in: 'is not one of',
  between: 'between', is_null: 'is empty', is_not_null: 'is not empty',
  contains: 'contains', starts_with: 'starts with',
  preset: 'date preset',
};

const PRESET_LABELS: Record<ReportBuilderDatePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  this_fy: 'This financial year',
  last_fy: 'Last financial year',
};

const AGG_LABELS = {
  sum: 'Sum',
  count: 'Count',
  count_distinct: 'Count distinct',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  running_total: 'Running total',
};

function makeBlankSpec(): ReportBuilderSpec {
  return {
    model: 'Order',
    fields: ['orderNumber', 'customer.customerName', 'deliveryDate', 'totalAmount'],
    filters: [],
    groupBy: [],
    aggregates: [],
    orderBy: [],
  };
}

export default function ReportBuilderPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEdit = !!id;

  // Editing state
  const [spec, setSpec] = useState<ReportBuilderSpec>(makeBlankSpec());
  const [name, setName] = useState('Untitled report');
  const [visibility, setVisibility] = useState<'private' | 'distributor'>('private');
  const [previewResult, setPreviewResult] = useState<SavedReportRunResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteModal, setDeleteModal] = useState(false);

  // Load existing saved report if editing
  const { data: existing } = useQuery({
    queryKey: ['saved-report', id],
    queryFn: () => apiGet<SavedReportDto>(`/saved-reports/${id}`),
    enabled: isEdit,
  });

  /* eslint-disable react-hooks/set-state-in-effect --
   * Hydrating local form state from the fetched saved report on mount /
   * id change. The setSpec/setName/setVisibility triple is the intended
   * one-shot init after `existing` resolves. Guarded by the `if (existing)`
   * check so it fires exactly once per fetch.
   */
  useEffect(() => {
    if (existing) {
      setSpec(existing.spec);
      setName(existing.name);
      setVisibility(existing.visibility);
    }
  }, [existing]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const fields = FIELDS_BY_MODEL[spec.model];

  // ─── Field selection ─────────────────────────────────────────────
  const toggleField = (key: string) => {
    setSpec((s) => ({
      ...s,
      fields: s.fields.includes(key) ? s.fields.filter((f) => f !== key) : [...s.fields, key],
    }));
  };

  // ─── Model change (reset fields to defaults for new model) ───────
  const changeModel = (newModel: ReportBuilderModel) => {
    if (newModel === spec.model) return;
    if (!window.confirm('Changing the model will reset your fields, filters, and grouping. Continue?')) return;
    const defaults = FIELDS_BY_MODEL[newModel].slice(0, 4).map((f) => f.key);
    setSpec({
      model: newModel,
      fields: defaults,
      filters: [],
      groupBy: [],
      aggregates: [],
      orderBy: [],
    });
    setPreviewResult(null);
  };

  // ─── Filters ─────────────────────────────────────────────────────
  const addFilter = () => {
    const firstField = fields[0];
    setSpec((s) => ({
      ...s,
      filters: [...s.filters, { field: firstField.key, op: 'eq', value: '' } as ReportBuilderFilter],
    }));
  };
  const removeFilter = (i: number) => setSpec((s) => ({ ...s, filters: s.filters.filter((_, idx) => idx !== i) }));
  const updateFilter = (i: number, f: ReportBuilderFilter) => setSpec((s) => ({ ...s, filters: s.filters.map((cur, idx) => (idx === i ? f : cur)) }));

  // ─── GroupBy + Aggregates ────────────────────────────────────────
  const toggleGroupBy = (key: string) => {
    setSpec((s) => ({
      ...s,
      groupBy: s.groupBy.includes(key) ? s.groupBy.filter((g) => g !== key) : [...s.groupBy, key],
    }));
  };
  const addAggregate = () => {
    const aggField = fields.find((f) => f.aggregatable);
    setSpec((s) => ({
      ...s,
      aggregates: [...s.aggregates, { field: aggField?.key ?? 'rows', op: 'sum' } as ReportBuilderAggregate],
    }));
  };
  const removeAggregate = (i: number) => setSpec((s) => ({ ...s, aggregates: s.aggregates.filter((_, idx) => idx !== i) }));
  const updateAggregate = (i: number, a: ReportBuilderAggregate) => setSpec((s) => ({ ...s, aggregates: s.aggregates.map((cur, idx) => (idx === i ? a : cur)) }));

  // ─── Preview ─────────────────────────────────────────────────────
  const runPreview = async () => {
    setPreviewLoading(true);
    try {
      const res = await apiPost<SavedReportRunResult>('/saved-reports/preview', spec);
      setPreviewResult(res);
    } catch (e) {
      toast.error(getErrorMessage(e));
      setPreviewResult(null);
    } finally { setPreviewLoading(false); }
  };

  // ─── Save ────────────────────────────────────────────────────────
  const saveReport = async () => {
    if (!name.trim()) { toast.error('Give the report a name first'); return; }
    setSaving(true);
    try {
      if (isEdit) {
        const updated = await apiPut<SavedReportDto>(`/saved-reports/${id}`, { name: name.trim(), visibility, spec });
        toast.success(`Saved: ${updated.name}`);
      } else {
        const created = await apiPost<SavedReportDto>('/saved-reports', { name: name.trim(), visibility, spec });
        toast.success(`Created: ${created.name}`);
        navigate(`/app/report-builder/${created.id}`, { replace: true });
      }
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally { setSaving(false); }
  };

  const deleteReport = async () => {
    if (!id) return;
    try {
      await apiDelete(`/saved-reports/${id}`);
      toast.success('Report deleted');
      navigate('/app/reports');
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="secondary" onClick={() => navigate('/app/reports')}>
          <HiOutlineArrowLeft className="h-4 w-4" /> Back to Reports
        </Button>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Report name"
          className="input text-lg font-semibold flex-1"
        />
        <Select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as 'private' | 'distributor')}
          options={[
            { value: 'private', label: 'Private (only me)' },
            { value: 'distributor', label: 'Everyone in company' },
          ]}
        />
        <Button onClick={saveReport} loading={saving} disabled={!name.trim()}>
          {isEdit ? 'Save changes' : 'Save report'}
        </Button>
        {isEdit && (
          <Button variant="secondary" onClick={() => setDeleteModal(true)}>
            <HiOutlineTrash className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Section 1 — Model + Fields */}
      <div className="card p-4 space-y-3">
        <h3 className="font-semibold text-surface-900 dark:text-white">1. What are you reporting on?</h3>
        <div>
          <label className="label text-xs">Data source</label>
          <Select
            value={spec.model}
            onChange={(e) => changeModel(e.target.value as ReportBuilderModel)}
            options={(Object.keys(MODEL_LABELS) as ReportBuilderModel[]).map((m) => ({ value: m, label: MODEL_LABELS[m] }))}
          />
        </div>
        <div>
          <label className="label text-xs">Columns to show</label>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2 max-h-56 overflow-y-auto p-2 border border-surface-200 dark:border-surface-700 rounded-lg">
            {fields.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={spec.fields.includes(f.key)}
                  onChange={() => toggleField(f.key)}
                />
                <span>{f.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Section 2 — Filters */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-surface-900 dark:text-white">2. Filter (optional)</h3>
          <Button variant="secondary" onClick={addFilter} disabled={spec.filters.length >= 20}>
            <HiOutlinePlus className="h-4 w-4" /> Add filter
          </Button>
        </div>
        {spec.filters.length === 0 ? (
          <p className="text-sm text-surface-500">No filters — showing all rows.</p>
        ) : (
          <div className="space-y-2">
            {spec.filters.map((f, i) => (
              <FilterRow key={i} filter={f} fields={fields} onChange={(nf) => updateFilter(i, nf)} onRemove={() => removeFilter(i)} />
            ))}
          </div>
        )}
      </div>

      {/* Section 3 — Group + Summarise */}
      <div className="card p-4 space-y-3">
        <h3 className="font-semibold text-surface-900 dark:text-white">3. Group + Summarise (optional)</h3>
        <div>
          <label className="label text-xs">Group by</label>
          <div className="flex flex-wrap gap-2">
            {fields.filter((f) => f.groupable).map((f) => (
              <label key={f.key} className="flex items-center gap-1 text-sm border border-surface-300 dark:border-surface-700 rounded px-2 py-1">
                <input
                  type="checkbox"
                  checked={spec.groupBy.includes(f.key)}
                  onChange={() => toggleGroupBy(f.key)}
                />
                <span>{f.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label text-xs mb-0">Metrics</label>
            <Button variant="secondary" onClick={addAggregate} disabled={spec.aggregates.length >= 10}>
              <HiOutlinePlus className="h-4 w-4" /> Add metric
            </Button>
          </div>
          {spec.aggregates.length === 0 ? (
            <p className="text-sm text-surface-500">No metrics — grouping needs at least one metric to run.</p>
          ) : (
            <div className="space-y-2">
              {spec.aggregates.map((a, i) => (
                <AggregateRow key={i} agg={a} fields={fields} onChange={(na) => updateAggregate(i, na)} onRemove={() => removeAggregate(i)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Section 4 — Preview */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-surface-900 dark:text-white">4. Preview</h3>
          <Button onClick={runPreview} loading={previewLoading}>Run preview</Button>
        </div>
        {previewLoading ? (
          <div className="flex justify-center py-8"><Loader size="md" /></div>
        ) : !previewResult ? (
          <EmptyState title="Click Run preview" description="Preview the first 20 rows before saving." />
        ) : previewResult.rows.length === 0 ? (
          <EmptyState title="No matching rows" description="Try adjusting your filters." />
        ) : (
          <>
            {previewResult.meta.capped && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-200 p-3 text-sm">
                ⚠ Row cap hit — narrow your filters to see more.
              </div>
            )}
            {previewResult.meta.unindexedWarning && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-200 p-3 text-sm">
                ⚠ {previewResult.meta.unindexedWarning}
              </div>
            )}
            <p className="text-xs text-surface-500">
              {previewResult.meta.rowCount} rows · {previewResult.meta.durationMs}ms
            </p>
            <div className="overflow-x-auto max-h-96 border border-surface-200 dark:border-surface-700 rounded-lg">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface-50 dark:bg-surface-800">
                  <tr>
                    {previewResult.columns.map((c) => (
                      <th key={c.key} className="px-3 py-2 text-left font-semibold text-surface-600 dark:text-surface-300">{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewResult.rows.slice(0, 20).map((row, i) => (
                    <tr key={i} className="border-t border-surface-100 dark:border-surface-800">
                      {previewResult.columns.map((c) => (
                        <td key={c.key} className="px-3 py-1.5 text-surface-800 dark:text-surface-200">
                          {row[c.key] == null ? '—' : String(row[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <Modal open={deleteModal} onClose={() => setDeleteModal(false)} title="Delete this report?">
        <div className="space-y-3">
          <p className="text-sm">This can&apos;t be undone. The report will be gone for you + anyone who saw it.</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteModal(false)}>Cancel</Button>
            <Button onClick={deleteReport}>Delete</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ─── Filter row ──────────────────────────────────────────────────────

interface FilterRowProps {
  filter: ReportBuilderFilter;
  fields: FieldSpec[];
  onChange: (f: ReportBuilderFilter) => void;
  onRemove: () => void;
}
function FilterRow({ filter, fields, onChange, onRemove }: FilterRowProps) {
  const fieldOpts = fields.map((f) => ({ value: f.key, label: f.label }));
  const opOpts = (Object.keys(OP_LABELS) as ReportBuilderOp[]).map((op) => ({ value: op, label: OP_LABELS[op] }));

  const changeField = (newField: string) => onChange({ ...filter, field: newField } as ReportBuilderFilter);
  const changeOp = (newOp: ReportBuilderOp) => {
    // Reset the payload when the op family changes.
    switch (newOp) {
      case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte':
        onChange({ field: filter.field, op: newOp, value: '' }); break;
      case 'in': case 'not_in':
        onChange({ field: filter.field, op: newOp, values: [] }); break;
      case 'between':
        onChange({ field: filter.field, op: 'between', from: '', to: '' }); break;
      case 'is_null': case 'is_not_null':
        onChange({ field: filter.field, op: newOp }); break;
      case 'contains': case 'starts_with':
        onChange({ field: filter.field, op: newOp, value: '' }); break;
      case 'preset':
        onChange({ field: filter.field, op: 'preset', preset: 'this_month' }); break;
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Select value={filter.field} onChange={(e) => changeField(e.target.value)} options={fieldOpts} />
      <Select value={filter.op} onChange={(e) => changeOp(e.target.value as ReportBuilderOp)} options={opOpts} />
      {'value' in filter && (
        <input
          type="text"
          value={String(filter.value ?? '')}
          onChange={(e) => onChange({ ...filter, value: e.target.value } as ReportBuilderFilter)}
          className="input py-2 text-sm min-w-[160px]"
          placeholder="Value"
        />
      )}
      {'values' in filter && (
        <input
          type="text"
          value={filter.values.join(', ')}
          onChange={(e) => onChange({ ...filter, values: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })}
          className="input py-2 text-sm min-w-[200px]"
          placeholder="Value1, Value2, ..."
        />
      )}
      {'from' in filter && 'to' in filter && (
        <>
          <input
            type="text" value={String(filter.from ?? '')}
            onChange={(e) => onChange({ ...filter, from: e.target.value })}
            className="input py-2 text-sm w-32" placeholder="From"
          />
          <span className="text-sm">to</span>
          <input
            type="text" value={String(filter.to ?? '')}
            onChange={(e) => onChange({ ...filter, to: e.target.value })}
            className="input py-2 text-sm w-32" placeholder="To"
          />
        </>
      )}
      {'preset' in filter && (
        <Select
          value={filter.preset}
          onChange={(e) => onChange({ ...filter, preset: e.target.value as ReportBuilderDatePreset })}
          options={(Object.keys(PRESET_LABELS) as ReportBuilderDatePreset[]).map((p) => ({ value: p, label: PRESET_LABELS[p] }))}
        />
      )}
      <Button variant="secondary" onClick={onRemove} title="Remove filter">
        <HiOutlineTrash className="h-4 w-4" />
      </Button>
    </div>
  );
}

// ─── Aggregate row ───────────────────────────────────────────────────

interface AggRowProps {
  agg: ReportBuilderAggregate;
  fields: FieldSpec[];
  onChange: (a: ReportBuilderAggregate) => void;
  onRemove: () => void;
}
function AggregateRow({ agg, fields, onChange, onRemove }: AggRowProps) {
  const aggFields = [
    { value: 'rows', label: '(all rows)' },
    ...fields.filter((f) => f.aggregatable).map((f) => ({ value: f.key, label: f.label })),
  ];
  const opOpts = (Object.keys(AGG_LABELS) as (keyof typeof AGG_LABELS)[]).map((op) => ({ value: op, label: AGG_LABELS[op] }));
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Select value={agg.op} onChange={(e) => onChange({ ...agg, op: e.target.value as ReportBuilderAggregate['op'] })} options={opOpts} />
      <span className="text-sm">of</span>
      <Select value={agg.field} onChange={(e) => onChange({ ...agg, field: e.target.value })} options={aggFields} />
      <span className="text-sm">as</span>
      <input
        type="text"
        value={agg.as ?? ''}
        onChange={(e) => onChange({ ...agg, as: e.target.value })}
        className="input py-2 text-sm w-40"
        placeholder="Column name"
      />
      <Button variant="secondary" onClick={onRemove} title="Remove metric">
        <HiOutlineTrash className="h-4 w-4" />
      </Button>
    </div>
  );
}
