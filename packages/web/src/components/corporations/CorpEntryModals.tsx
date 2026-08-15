/**
 * F8 v2 Corporation-Entry modals (2026-08-06)
 *
 * All 6 "Add Entry" modals for the Corporation Ledger page, in one file
 * so the top-level page stays a shell + the modals share their local
 * types/API contracts.
 *
 *   • IncomingFullsCorpModal  — multi-line OMC invoice (COMM 5% + DOM 18%
 *     + freight). Writes PurchaseEntry + InventoryEvent via existing
 *     POST /api/purchase-entries.
 *   • DepositInvoiceModal      — same endpoint with documentType='deposit_invoice'.
 *   • PaymentModal             — POST /api/purchase-payments.
 *   • CreditNoteModal          — POST /api/purchase-credit-notes.
 *   • DebitNoteModal           — POST /api/purchase-debit-notes.
 *   • Outgoing Empties is handled by navigating to the Inventory page's
 *     existing OutgoingEmptiesModal via a query param — reuses the F1
 *     defective-return-inclusion logic already there.
 *
 * All modals accept `corp` (the SupplierBalance context) + `onClose`
 * + `onSaved` callbacks. On success, `onSaved` fires so the parent
 * page can invalidate its queries.
 */
import { useMemo } from 'react';
import { useForm, useFieldArray, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  createPurchaseEntrySchema,
  type CreatePurchaseEntryInput,
  createPurchaseCreditNoteSchema,
  type CreatePurchaseCreditNoteInput,
  createPurchaseDebitNoteSchema,
  type CreatePurchaseDebitNoteInput,
  PURCHASE_CREDIT_NOTE_REASONS,
  PURCHASE_DEBIT_NOTE_REASONS,
  localTodayISO,
} from '@gaslink/shared';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { Button, Input, Modal, Select } from '@/components/ui';

// F8v2-FIX-A (2026-08-06) — Deposit modal is the only Corp-page modal
// that still needs its own cylinder-type dropdown (the shared Incoming/
// Outgoing Empties modals are imported directly from InventoryPage now).

// ─── Shared types ──────────────────────────────────────────────────────────

export interface CorpContext {
  sourceDistributorId: string;
  name: string;
}

interface CylinderType {
  cylinderTypeId: string;
  typeName: string;
}

interface OutstandingEntry {
  purchaseEntryId: string;
  purchaseNumber: string;
  purchaseDate: string;
  total: number;
  amountPaid: number;
  outstanding: number;
  amountRemaining?: number;
  supplierDocumentNumber?: string | null;
  documentType?: string;
}

function useCylinderTypes(): { data: CylinderType[] } {
  // F8 v2 (2026-08-06) — bump queryKey to bust any prior cache entry that
  // stored the raw `{ cylinderTypes: [...] }` envelope. Also defensively
  // handle either shape (endpoint may or may not be wrapped).
  const q = useQuery({
    queryKey: ['cylinder-types-v2'],
    queryFn: async () => {
      const res = await apiGet<{ cylinderTypes?: CylinderType[] } | CylinderType[]>('/cylinder-types');
      if (Array.isArray(res)) return res;
      return res?.cylinderTypes ?? [];
    },
  });
  return { data: Array.isArray(q.data) ? q.data : [] };
}

// F8v2-FIX-A (2026-08-06) — deleted IncomingFullsCorpModal. Corp Ledger
// now imports { IncomingFullsModal, OutgoingEmptiesModal } directly from
// InventoryPage so both surfaces open the SAME modal (Suneel's ask).
// Only Corp-specific modals stay here: Deposit / Payment / CN / DN.

// ─── Deposit Invoice modal (documentType=deposit_invoice, Nil GST) ────────

export function DepositInvoiceModal({
  corp,
  onClose,
  onSaved,
}: {
  corp: CorpContext;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: cylTypes = [] } = useCylinderTypes();
  const { register, handleSubmit, control, formState: { errors } } = useForm<CreatePurchaseEntryInput>({
    resolver: zodResolver(createPurchaseEntrySchema),
    defaultValues: {
      sourceDistributorId: corp.sourceDistributorId,
      purchaseDate: localTodayISO(),
      documentType: 'deposit_invoice',
      items: [{ cylinderTypeId: '', fullsReceived: 0, emptiesGivenOut: 0, unitPrice: 0, gstRate: 0 }],
      charges: [],
    },
  });
  const items = useFieldArray({ control, name: 'items' });
  const watchedItems = useWatch({ control, name: 'items' }) ?? [];
  const grandTotal = useMemo(
    () => (watchedItems ?? []).reduce((s, it) => s + Number(it?.unitPrice ?? 0) * Number(it?.fullsReceived ?? 0), 0),
    [watchedItems],
  );

  const mutation = useMutation({
    mutationFn: (data: CreatePurchaseEntryInput) => apiPost('/purchase-entries', data),
    onSuccess: () => {
      toast.success('Deposit invoice recorded');
      onSaved();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const cylOpts = cylTypes.map((c) => ({ value: c.cylinderTypeId, label: c.typeName }));

  return (
    <Modal open onClose={onClose} title={`Cylinder Deposit — ${corp.name}`} size="lg">
      <form onSubmit={handleSubmit((d) => mutation.mutate({ ...d, documentType: 'deposit_invoice' }))} className="space-y-4">
        <div className="rounded-md bg-blue-50 p-3 text-xs text-blue-800">
          Deposit invoices are Nil-GST and refundable — they do NOT count toward gas outstanding
          or landed cost. Balance shows separately on the &ldquo;Deposit Balance&rdquo; summary chip.
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Input label="OMC Deposit Invoice No" placeholder="e.g. LI026S-00290" {...register('supplierDocumentNumber')} />
          <Input label="Invoice Date" type="date" required error={errors.purchaseDate?.message} {...register('purchaseDate')} />
          <Input label="Plant" placeholder="e.g. Sanaswadi" {...register('plantName')} />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Cylinders added to pool</label>
            <Button
              type="button"
              variant="secondary"
              onClick={() => items.append({ cylinderTypeId: '', fullsReceived: 0, emptiesGivenOut: 0, unitPrice: 0, gstRate: 0 })}
            >
              + Add line
            </Button>
          </div>
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-700">
                <tr>
                  <th className="p-2 text-left">Cylinder Type</th>
                  <th className="p-2 text-right w-20">Qty</th>
                  <th className="p-2 text-right w-28">Deposit/cyl ₹</th>
                  <th className="p-2 text-right w-28">Line Total ₹</th>
                  <th className="p-2 w-12"></th>
                </tr>
              </thead>
              <tbody>
                {items.fields.map((f, i) => {
                  const it = watchedItems[i];
                  const lineTotal = Number(it?.unitPrice ?? 0) * Number(it?.fullsReceived ?? 0);
                  return (
                    <tr key={f.id} className="border-t border-slate-200">
                      <td className="p-2">
                        <Select options={cylOpts} placeholder="Select" {...register(`items.${i}.cylinderTypeId` as const)} />
                      </td>
                      <td className="p-2">
                        <input type="number" min={0} className="w-full rounded border border-slate-300 px-2 py-1 text-right"
                          {...register(`items.${i}.fullsReceived` as const, { valueAsNumber: true })} />
                      </td>
                      <td className="p-2">
                        <input type="number" min={0} step="0.01" className="w-full rounded border border-slate-300 px-2 py-1 text-right"
                          {...register(`items.${i}.unitPrice` as const, { valueAsNumber: true })} />
                      </td>
                      <td className="p-2 text-right font-medium">₹{lineTotal.toFixed(2)}</td>
                      <td className="p-2">
                        {items.fields.length > 1 && (
                          <Button type="button" variant="secondary" onClick={() => items.remove(i)}>×</Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <Input label="Notes (optional)" {...register('notes')} />
        <div className="flex items-center justify-between rounded-md bg-slate-50 p-3">
          <span className="text-sm text-slate-600">Total deposit</span>
          <span className="text-lg font-semibold">₹{grandTotal.toFixed(2)}</span>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Record Deposit</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Payment modal ─────────────────────────────────────────────────────────

interface PaymentFormValues {
  sourceDistributorId: string;
  transactionDate: string;
  amount: number;
  paymentMethod: 'cash' | 'bank_transfer' | 'upi' | 'cheque' | 'online' | 'credit';
  referenceNumber?: string;
  notes?: string;
}

export function PaymentModal({
  corp,
  onClose,
  onSaved,
}: {
  corp: CorpContext;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<PaymentFormValues>({
    defaultValues: {
      sourceDistributorId: corp.sourceDistributorId,
      transactionDate: localTodayISO(),
      amount: 0,
      paymentMethod: 'bank_transfer',
    },
  });
  const mutation = useMutation({
    mutationFn: (data: PaymentFormValues) => apiPost('/purchase-payments', data),
    onSuccess: () => {
      toast.success('Payment recorded');
      onSaved();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  return (
    <Modal open onClose={onClose} title={`Payment — ${corp.name}`} size="md">
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Payment Date" type="date" required error={errors.transactionDate?.message}
            {...register('transactionDate')} />
          <Input label="Amount (₹)" type="number" min={0} step="0.01" required
            error={errors.amount?.message} {...register('amount', { valueAsNumber: true })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Method"
            options={[
              { value: 'bank_transfer', label: 'Bank Transfer' },
              { value: 'cash', label: 'Cash' },
              { value: 'upi', label: 'UPI' },
              { value: 'cheque', label: 'Cheque' },
              { value: 'online', label: 'Online / Card' },
            ]}
            {...register('paymentMethod')}
          />
          <Input label="Reference No" placeholder="e.g. ICICI txn / cheque #" {...register('referenceNumber')} />
        </div>
        <Input label="Notes (optional)" {...register('notes')} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Record Payment</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Credit Note modal (from OMC) ──────────────────────────────────────────

export function CreditNoteModal({
  corp,
  onClose,
  onSaved,
}: {
  corp: CorpContext;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { register, handleSubmit, control, formState: { errors }, setValue } = useForm<CreatePurchaseCreditNoteInput>({
    resolver: zodResolver(createPurchaseCreditNoteSchema),
    defaultValues: {
      sourceDistributorId: corp.sourceDistributorId,
      creditNoteNumber: '',
      creditNoteDate: localTodayISO(),
      receivedDate: localTodayISO(),
      totalAmount: 0,
      reason: 'volume_incentive',
      allocations: [],
    },
  });
  return (
    <NoteModalShell
      title={`Credit Note — ${corp.name}`}
      corp={corp}
      onClose={onClose}
      onSaved={onSaved}
      register={register as never}
      handleSubmit={handleSubmit as never}
      control={control as never}
      errors={errors as never}
      setValue={setValue as never}
      endpoint="/purchase-credit-notes"
      numberFieldLabel="OMC CN No"
      numberField="creditNoteNumber"
      dateFieldLabel="CN Date (OMC)"
      dateField="creditNoteDate"
      reasonOpts={PURCHASE_CREDIT_NOTE_REASONS.map((r) => ({
        value: r,
        label: r.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
      }))}
      submitLabel="Record Credit Note"
      successLabel="Credit note recorded"
    />
  );
}

// ─── Debit Note modal (from OMC) ───────────────────────────────────────────

export function DebitNoteModal({
  corp,
  onClose,
  onSaved,
}: {
  corp: CorpContext;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { register, handleSubmit, control, formState: { errors }, setValue } = useForm<CreatePurchaseDebitNoteInput>({
    resolver: zodResolver(createPurchaseDebitNoteSchema),
    defaultValues: {
      sourceDistributorId: corp.sourceDistributorId,
      debitNoteNumber: '',
      debitNoteDate: localTodayISO(),
      receivedDate: localTodayISO(),
      totalAmount: 0,
      reason: 'short_supply',
      allocations: [],
    },
  });
  return (
    <NoteModalShell
      title={`Debit Note — ${corp.name}`}
      corp={corp}
      onClose={onClose}
      onSaved={onSaved}
      register={register as never}
      handleSubmit={handleSubmit as never}
      control={control as never}
      errors={errors as never}
      setValue={setValue as never}
      endpoint="/purchase-debit-notes"
      numberFieldLabel="OMC DN No"
      numberField="debitNoteNumber"
      dateFieldLabel="DN Date (OMC)"
      dateField="debitNoteDate"
      reasonOpts={PURCHASE_DEBIT_NOTE_REASONS.map((r) => ({
        value: r,
        label: r.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
      }))}
      submitLabel="Record Debit Note"
      successLabel="Debit note recorded"
    />
  );
}

// ─── Shared CN/DN modal shell (JSX only — form state passed in) ─────────────
// The two note kinds have structurally identical UIs but different zod
// schemas + field names. Sharing the JSX skeleton keeps them in lock-step
// without forcing the schema-generic type gymnastics that ruined the first
// draft. Callers own the useForm hook; we get typed `register` + `errors`.

function NoteModalShell(props: {
  title: string;
  corp: CorpContext;
  onClose: () => void;
  onSaved: () => void;
  register: (name: string, opts?: unknown) => Record<string, unknown>;
  handleSubmit: (fn: (data: unknown) => void) => (e?: React.BaseSyntheticEvent) => Promise<void>;
  control: unknown;
  errors: Record<string, { message?: string } | undefined>;
  setValue: (name: string, value: unknown, opts?: { shouldDirty?: boolean }) => void;
  endpoint: string;
  numberFieldLabel: string;
  numberField: string;
  dateFieldLabel: string;
  dateField: string;
  reasonOpts: Array<{ value: string; label: string }>;
  submitLabel: string;
  successLabel: string;
}) {
  const {
    title, corp, onClose, onSaved, register, handleSubmit, control, errors, setValue,
    endpoint, numberFieldLabel, numberField, dateFieldLabel, dateField, reasonOpts,
    submitLabel, successLabel,
  } = props;

  // Force `control` cast to satisfy useFieldArray without exposing the
  // concrete generic to this shell.
  const { fields, append, remove, update } = useFieldArray({
    control: control as never,
    name: 'allocations' as never,
  });

  const { data: outstandingResp } = useQuery({
    queryKey: ['purchase-outstanding', corp.sourceDistributorId],
    queryFn: () =>
      apiGet<{ entries: OutstandingEntry[] }>(`/purchase-payments/outstanding/${corp.sourceDistributorId}`),
  });
  // 2026-08-15 — CN/DN are gas-only; exclude deposit invoices from the
  // allocation list (a volume-incentive CN must not reduce a refundable
  // cylinder deposit — Suneel). Deposits are settled via payments/refunds only.
  const outstanding = (outstandingResp?.entries ?? []).filter(
    (e) => e.documentType !== 'deposit_invoice',
  );

  const mutation = useMutation({
    mutationFn: (data: unknown) => apiPost(endpoint, data),
    onSuccess: () => {
      toast.success(successLabel);
      onSaved();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const allocSum = fields.reduce((s, _, i) => {
    const raw = (fields[i] as unknown as { amount?: number }).amount;
    return s + (typeof raw === 'number' && Number.isFinite(raw) ? raw : 0);
  }, 0);

  return (
    <Modal open onClose={onClose} title={title} size="lg">
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input
            label={numberFieldLabel}
            placeholder="Number from OMC's document"
            required
            error={errors[numberField]?.message}
            {...register(numberField)}
          />
          <Select label="Reason" options={reasonOpts} {...register('reason')} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Input label={dateFieldLabel} type="date" required {...register(dateField)} />
          <Input label="Received On" type="date" required {...register('receivedDate')} />
          <Input label="Total Amount (₹)" type="number" min={0} step="0.01" required
            error={errors.totalAmount?.message}
            {...register('totalAmount', { valueAsNumber: true })} />
        </div>
        <Input label="Notes (optional)" {...register('notes')} />
        <div className="space-y-2 border-t border-slate-200 pt-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Allocate to purchase invoices</label>
            <div className="text-xs text-slate-600">Allocated: <b>₹{allocSum.toFixed(2)}</b></div>
          </div>
          {outstanding.length === 0 ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              No outstanding invoices for this corporation. Record a purchase entry first.
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto rounded-md border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-600">
                  <tr>
                    <th className="p-2 text-left">Include</th>
                    <th className="p-2 text-left">Invoice</th>
                    <th className="p-2 text-left">Date</th>
                    <th className="p-2 text-right">Outstanding</th>
                    <th className="p-2 text-right">Allocate ₹</th>
                  </tr>
                </thead>
                <tbody>
                  {outstanding.map((row) => {
                    const idx = fields.findIndex(
                      (f) => (f as unknown as { purchaseEntryId?: string }).purchaseEntryId === row.purchaseEntryId,
                    );
                    const included = idx >= 0;
                    const remaining = row.amountRemaining ?? row.outstanding;
                    return (
                      <tr key={row.purchaseEntryId} className="border-t border-slate-200">
                        <td className="p-2">
                          <input
                            type="checkbox"
                            checked={included}
                            onChange={(e) => {
                              if (e.target.checked) {
                                append({ purchaseEntryId: row.purchaseEntryId, amount: remaining } as never);
                              } else if (idx >= 0) {
                                remove(idx);
                              }
                            }}
                          />
                        </td>
                        <td className="p-2 font-mono text-xs">
                          {/* Never fall back to the internal PSHD auto-number —
                              only the OMC's own reference is user-facing. */}
                          {row.supplierDocumentNumber ?? '—'}
                        </td>
                        <td className="p-2 text-slate-600">{row.purchaseDate}</td>
                        <td className="p-2 text-right">₹{remaining.toFixed(2)}</td>
                        <td className="p-2 text-right">
                          {included ? (
                            <input
                              type="number"
                              min={0}
                              max={remaining}
                              step="0.01"
                              className="w-28 rounded border border-slate-300 px-2 py-1 text-right"
                              defaultValue={
                                (fields[idx] as unknown as { amount?: number }).amount ?? remaining
                              }
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                update(idx, {
                                  purchaseEntryId: row.purchaseEntryId,
                                  amount: Number.isFinite(v) ? v : 0,
                                } as never);
                                setValue(`allocations.${idx}.amount`, Number.isFinite(v) ? v : 0, {
                                  shouldDirty: true,
                                });
                              }}
                            />
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {errors.allocations?.message && (
            <p className="text-xs text-red-600">{errors.allocations.message}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending} disabled={outstanding.length === 0}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
