/**
 * WI-4 — Report Mismatch (3-step form) + Mismatch Log.
 *
 * Extracted from InventoryPage.tsx so the page's already-large file
 * stays readable. The two components are tightly co-located because
 * the log is rendered immediately below the Vehicle Return cards and
 * the modal feeds the same `mismatch-log` query key on success.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { localTodayISO } from '@gaslink/shared';
import { api, apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Modal, Badge } from '@/components/ui';

export interface ReconciliationVehicleLite {
  vehicleId: string;
  vehicleNumber: string;
}

interface CylinderTypeForMismatch {
  cylinderTypeId: string;
  typeName: string;
  emptyDepositPrice?: number | null;
  latestPrice?: number | null;
}

interface DriverOption { driverId: string; driverName: string }
interface CustomerOption { customerId: string; customerName: string }

interface MismatchSubmitPayload {
  vehicleId: string;
  tripDate: string;
  accountableParty: 'driver' | 'customer';
  driverId?: string;
  customerId?: string;
  resolutionAction: 'write_off' | 'settle_against_due';
  resolutionNotes: string;
  lines: Array<{
    mismatchType: 'empties_short' | 'fulls_short' | 'both';
    cylinderTypeId: string;
    qtyUnaccounted: number;
    unitAmount: number;
    totalAmount: number;
  }>;
}

export function ReportMismatchModal({
  vehicle,
  cylinderTypes,
  onClose,
}: {
  vehicle: ReconciliationVehicleLite;
  cylinderTypes: CylinderTypeForMismatch[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [mismatchType, setMismatchType] = useState<'empties_short' | 'fulls_short' | 'both'>('empties_short');
  const [cylinderTypeId, setCylinderTypeId] = useState('');
  const [qty, setQty] = useState<string>('');
  const [accountableParty, setAccountableParty] = useState<'driver' | 'customer'>('driver');
  const [driverId, setDriverId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [resolutionAction, setResolutionAction] = useState<'write_off' | 'settle_against_due'>('write_off');
  const [resolutionNotes, setResolutionNotes] = useState('');

  const driversQuery = useQuery<{ drivers: DriverOption[] }>({
    queryKey: ['drivers-for-mismatch'],
    queryFn: () => apiGet('/drivers'),
    enabled: accountableParty === 'driver',
  });
  const customersQuery = useQuery<{ data: CustomerOption[] }>({
    queryKey: ['customers-for-mismatch'],
    queryFn: () => apiGet('/customers?pageSize=200'),
    enabled: accountableParty === 'customer',
  });

  const selectedCt = cylinderTypes.find((c) => c.cylinderTypeId === cylinderTypeId);
  const depositPrice = selectedCt?.emptyDepositPrice ?? 0;
  // WI-4 — Empties Short = qty x deposit. Fulls Short = qty x (cylinder + deposit).
  // Both = qty x (cylinder + 2 x deposit) — empties + fulls per cylinder. The
  // cylinder unit price comes from the cylinder-type record (latestPrice)
  // when present; otherwise admin can correct in resolution notes.
  const cylinderUnitPrice = selectedCt?.latestPrice ?? 0;
  const qtyNum = Math.max(0, Math.floor(Number(qty) || 0));
  const unitAmount =
    mismatchType === 'empties_short' ? depositPrice
      : mismatchType === 'fulls_short' ? cylinderUnitPrice + depositPrice
      : cylinderUnitPrice + 2 * depositPrice;
  const totalAmount = Math.round(qtyNum * unitAmount * 100) / 100;

  const mutation = useMutation({
    mutationFn: (payload: MismatchSubmitPayload) =>
      apiPost<{ reportId: string; autoClose: { closed: boolean; reason?: string; closeError?: string } }>(
        '/inventory/mismatch-reports', payload,
      ),
    onSuccess: (result) => {
      // Option A — back-end auto-closes the trip when the mismatch covers
      // the full remaining gap. Reflect that in the toast so the user knows
      // why the Vehicle Return card disappeared (or didn't).
      if (result.autoClose?.closed) {
        toast.success('Mismatch recorded — trip closed and vehicle marked idle');
      } else if (result.autoClose?.reason === 'gap_remaining') {
        toast.success('Mismatch recorded — gap partial, vehicle still pending return');
      } else if (result.autoClose?.reason === 'close_failed') {
        toast.error(
          `Mismatch recorded but auto-close failed: ${result.autoClose.closeError ?? 'unknown error'}. Please retry Confirm & Reconcile.`,
          { duration: 8000 },
        );
      } else {
        toast.success('Mismatch report submitted');
      }
      queryClient.invalidateQueries({ queryKey: ['reconciliation-pending'] });
      queryClient.invalidateQueries({ queryKey: ['mismatch-log'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['pending-actions'] });
      onClose();
    },
    onError: (e) => toast.error(getErrorMessage(e)),
  });

  const canSubmit = qtyNum > 0
    && !!cylinderTypeId
    && (accountableParty === 'driver' ? !!driverId : !!customerId)
    && !!resolutionNotes.trim();

  const submit = () => {
    if (!canSubmit) return;
    mutation.mutate({
      vehicleId: vehicle.vehicleId,
      tripDate: localTodayISO(),
      accountableParty,
      driverId: accountableParty === 'driver' ? driverId : undefined,
      customerId: accountableParty === 'customer' ? customerId : undefined,
      resolutionAction,
      resolutionNotes: resolutionNotes.trim(),
      lines: [{ mismatchType, cylinderTypeId, qtyUnaccounted: qtyNum, unitAmount, totalAmount }],
    });
  };

  return (
    <Modal open onClose={onClose} title={`Report Mismatch — ${vehicle.vehicleNumber}`}>
      <div className="flex items-center gap-2 text-xs text-surface-500 mb-4">
        <span className={step === 1 ? 'font-semibold text-brand-600' : ''}>1. What is short</span>
        <span>›</span>
        <span className={step === 2 ? 'font-semibold text-brand-600' : ''}>2. Accountability</span>
        <span>›</span>
        <span className={step === 3 ? 'font-semibold text-brand-600' : ''}>3. Resolution</span>
      </div>

      {step === 1 && (
        <div className="space-y-4">
          <Select
            label="Mismatch Type"
            options={[
              { value: 'empties_short', label: 'Empties Short' },
              { value: 'fulls_short', label: 'Fulls Short' },
              { value: 'both', label: 'Both' },
            ]}
            value={mismatchType}
            onChange={(e) => setMismatchType(e.target.value as 'empties_short' | 'fulls_short' | 'both')}
          />
          <Select
            label="Cylinder Type"
            options={cylinderTypes.map((c) => ({ value: c.cylinderTypeId, label: c.typeName }))}
            placeholder="Select type"
            value={cylinderTypeId}
            onChange={(e) => setCylinderTypeId(e.target.value)}
            required
          />
          <Input
            label="Quantity unaccounted"
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            required
          />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="button" onClick={() => setStep(2)} disabled={!cylinderTypeId || qtyNum <= 0}>Next</Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <Select
            label="Accountable Party"
            options={[
              { value: 'driver', label: 'Driver' },
              { value: 'customer', label: 'Customer' },
            ]}
            value={accountableParty}
            onChange={(e) => setAccountableParty(e.target.value as 'driver' | 'customer')}
          />
          {accountableParty === 'driver' ? (
            <Select
              label="Driver"
              options={(driversQuery.data?.drivers ?? []).map((d) => ({ value: d.driverId, label: d.driverName }))}
              placeholder={driversQuery.isLoading ? 'Loading...' : 'Select driver'}
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
              required
            />
          ) : (
            <Select
              label="Customer"
              options={(customersQuery.data?.data ?? []).map((c) => ({ value: c.customerId, label: c.customerName }))}
              placeholder={customersQuery.isLoading ? 'Loading...' : 'Select customer'}
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              required
            />
          )}
          <div className="rounded-md bg-surface-50 dark:bg-surface-800/50 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-surface-500">Unit Amount</span>
              <span className="font-mono">Rs.{unitAmount.toLocaleString('en-IN')}</span>
            </div>
            <div className="flex justify-between font-semibold mt-1">
              <span>Total Amount</span>
              <span className="font-mono">Rs.{totalAmount.toLocaleString('en-IN')}</span>
            </div>
            <p className="text-xs text-surface-400 mt-2">
              Empties Short: qty x empty deposit price. Fulls Short: qty x
              (cylinder unit price + deposit). Set the deposit in Settings then
              Empty Deposit Prices.
            </p>
          </div>
          <div className="flex justify-between gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setStep(1)}>Back</Button>
            <div className="flex gap-3">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button
                type="button"
                onClick={() => setStep(3)}
                disabled={accountableParty === 'driver' ? !driverId : !customerId}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <Select
            label="Resolution Action"
            options={[
              { value: 'write_off', label: 'Write off' },
              { value: 'settle_against_due', label: 'Settle against payment / due' },
            ]}
            value={resolutionAction}
            onChange={(e) => setResolutionAction(e.target.value as 'write_off' | 'settle_against_due')}
          />
          <div>
            <label className="label">Resolution Notes <span className="text-red-500">*</span></label>
            <textarea
              className="input min-h-[80px]"
              value={resolutionNotes}
              onChange={(e) => setResolutionNotes(e.target.value)}
              placeholder="Reason / investigation outcome (required)"
            />
          </div>
          <div className="flex justify-between gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setStep(2)}>Back</Button>
            <div className="flex gap-3">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button type="button" onClick={submit} disabled={!canSubmit} loading={mutation.isPending}>
                Submit
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── Mismatch & Correction Log ──────────────────────────────────────────────

interface MismatchLogRow {
  recordId: string;
  reportId: string;
  vehicleNumber: string;
  driverName: string | null;
  customerName: string | null;
  accountableParty: 'driver' | 'customer';
  tripDate: string;
  mismatchType: 'empties_short' | 'fulls_short' | 'both';
  cylinderTypeName: string;
  qtyUnaccounted: number;
  unitAmount: number;
  totalAmount: number;
  resolutionAction: 'write_off' | 'settle_against_due';
  resolutionNotes: string;
  status: 'open' | 'resolved';
  createdAt: string;
}

export function MismatchLogSection() {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [statusF, setStatusF] = useState<'all' | 'open' | 'resolved'>('all');
  const [typeF, setTypeF] = useState<'all' | 'empties_short' | 'fulls_short' | 'both'>('all');
  const [fromF, setFromF] = useState('');
  const [toF, setToF] = useState('');

  const query = useQuery<{ data: MismatchLogRow[]; meta: { page: number; pageSize: number; total: number; totalPages: number } }>({
    queryKey: ['mismatch-log', { page, statusF, typeF, fromF, toF }],
    queryFn: () => {
      const q = new URLSearchParams();
      q.set('page', String(page));
      q.set('pageSize', '50');
      if (statusF !== 'all') q.set('status', statusF);
      if (typeF !== 'all') q.set('mismatchType', typeF);
      if (fromF) q.set('dateFrom', fromF);
      if (toF) q.set('dateTo', toF);
      return apiGet(`/inventory/mismatch-reports?${q.toString()}`);
    },
    enabled: open,
  });

  const downloadCsv = async () => {
    const params: Record<string, string> = { format: 'csv' };
    if (statusF !== 'all') params.status = statusF;
    if (typeF !== 'all') params.mismatchType = typeF;
    if (fromF) params.dateFrom = fromF;
    if (toF) params.dateTo = toF;
    try {
      const res = await api.get('/inventory/mismatch-reports', { params, responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mismatch-log.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  return (
    <div className="mt-6 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-surface-50 dark:hover:bg-surface-800/50"
      >
        <span className="font-semibold text-surface-900 dark:text-white">
          Mismatch &amp; Correction Log
        </span>
        <span className="text-surface-400">{open ? 'v' : '>'}</span>
      </button>
      {open && (
        <div className="p-5 space-y-4 border-t border-surface-200 dark:border-surface-700">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Select
              label="Status"
              options={[
                { value: 'all', label: 'All' },
                { value: 'open', label: 'Open' },
                { value: 'resolved', label: 'Resolved' },
              ]}
              value={statusF}
              onChange={(e) => { setPage(1); setStatusF(e.target.value as 'all' | 'open' | 'resolved'); }}
            />
            <Select
              label="Type"
              options={[
                { value: 'all', label: 'All' },
                { value: 'empties_short', label: 'Empties Short' },
                { value: 'fulls_short', label: 'Fulls Short' },
                { value: 'both', label: 'Both' },
              ]}
              value={typeF}
              onChange={(e) => { setPage(1); setTypeF(e.target.value as 'all' | 'empties_short' | 'fulls_short' | 'both'); }}
            />
            <Input label="From" type="date" value={fromF} onChange={(e) => { setPage(1); setFromF(e.target.value); }} />
            <Input label="To" type="date" value={toF} onChange={(e) => { setPage(1); setToF(e.target.value); }} />
          </div>
          <div className="border border-surface-200 dark:border-surface-700 rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-50 dark:bg-surface-800/50 text-xs uppercase text-surface-500">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Vehicle</th>
                  <th className="px-3 py-2 text-left">Accountable</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-left">Cylinder</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Amt</th>
                  <th className="px-3 py-2 text-left">Resolution</th>
                  <th className="px-3 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {query.isLoading ? (
                  <tr><td colSpan={9} className="px-3 py-4 text-center text-surface-400">Loading...</td></tr>
                ) : (query.data?.data.length ?? 0) === 0 ? (
                  <tr><td colSpan={9} className="px-3 py-4 text-center text-surface-400">No mismatch records.</td></tr>
                ) : (
                  query.data!.data.map((r) => (
                    <tr key={r.recordId} className="border-t border-surface-200 dark:border-surface-700">
                      <td className="px-3 py-2">{r.tripDate}</td>
                      <td className="px-3 py-2 font-medium">{r.vehicleNumber}</td>
                      <td className="px-3 py-2">{r.accountableParty === 'driver' ? (r.driverName ?? '-') : (r.customerName ?? '-')}</td>
                      <td className="px-3 py-2 capitalize">{r.mismatchType.replace('_', ' ')}</td>
                      <td className="px-3 py-2">{r.cylinderTypeName}</td>
                      <td className="px-3 py-2 text-right font-mono">{r.qtyUnaccounted}</td>
                      <td className="px-3 py-2 text-right font-mono">Rs.{r.totalAmount.toLocaleString('en-IN')}</td>
                      <td className="px-3 py-2 capitalize">{r.resolutionAction.replace('_', ' ')}</td>
                      <td className="px-3 py-2">
                        <Badge variant={r.status === 'resolved' ? 'success' : 'warning'}>{r.status}</Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="secondary" onClick={downloadCsv} disabled={(query.data?.data.length ?? 0) === 0}>
              Download CSV
            </Button>
            <div className="flex items-center gap-2 text-sm text-surface-500">
              <Button type="button" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Prev
              </Button>
              <span>
                Page {query.data?.meta.page ?? 1} / {query.data?.meta.totalPages ?? 1}
              </span>
              <Button type="button" variant="secondary" disabled={(query.data?.meta.totalPages ?? 1) <= page} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
