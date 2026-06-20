import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Loader } from './ui/Loader';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// LoadListDispatchModal
//
// Two-state modal that replaces the inline LoadManifestPanel + immediate
// dispatch button on the OrdersPage dispatch card. The flow is:
//
//   STATE 1 (EDITOR)
//     - Per-cylinder-type rows: Booked (read-only) + Spare (editable) + Total
//     - [Cancel] [Save Load List]
//     - On Save: POST /api/manifests then transition to STATE 2
//
//   STATE 2 (CONFIRMATION)
//     - Summary of saved load list per cylinder type
//     - [Edit Load List] [Dispatch Now]
//     - On Dispatch Now: closes this modal and invokes parent's onDispatchNow,
//       which is responsible for triggering the existing preflight flow +
//       result modal. We do NOT call /preflight-dispatch from here.
//
// If a manifest already exists when the modal opens → start in STATE 2
// (skip the editor). Otherwise → start in STATE 1.
//
// Backend contract is unchanged:
//   GET  /api/manifests/dva/:dvaId   — read existing load list (pre-fill)
//   POST /api/manifests              — create/update (idempotent per DVA + trip)
//   POST /api/orders/preflight-dispatch — fired by parent (not this modal)
// ─────────────────────────────────────────────────────────────────────────────

type CylinderTypeRow = { cylinderTypeId: string; typeName: string };

type ManifestRow = {
  cylinderTypeId: string;
  cylinderTypeName?: string;
  totalLoaded: number;
  orderedQty: number;
  floatQty: number;
};

export interface LoadListDispatchModalProps {
  /** Open / closed control. Parent sets to true to mount. */
  open: boolean;
  /** Driver display name (e.g. "Raju Kumar"). */
  driverName: string;
  /** Vehicle plate (e.g. "KA01-DT-0002"). May be null if no mapping. */
  vehicleNumber: string | null;
  /** DVA id for the dispatch group. Required to load + save the manifest. */
  assignmentId: string;
  /** Current DVA trip number (cache-key scoping; bumps at reconcile). */
  tripNumber: number;
  /**
   * Pre-booked order line items for this dispatch group. Used to display the
   * Booked column before any manifest exists. After save, the server-stored
   * orderedQty wins.
   */
  orderItems: Array<{ cylinderTypeId: string; quantity: number }>;
  /** Called when the user clicks Cancel / Close / hits Escape. */
  onClose: () => void;
  /**
   * Called when the user clicks "Dispatch Now" from STATE 2. Parent is
   * expected to (a) close this modal, (b) fire the existing dispatch
   * flow (DispatchProgressModal on web). This modal does NOT call the
   * preflight endpoint itself.
   */
  onDispatchNow: () => void;
}

export function LoadListDispatchModal(props: LoadListDispatchModalProps) {
  const { open, driverName, vehicleNumber, assignmentId, tripNumber, orderItems, onClose, onDispatchNow } = props;
  const queryClient = useQueryClient();

  // Editable spare input per cylinder type (string so empty = "no change").
  const [spareByType, setSpareByType] = useState<Record<string, string>>({});
  // STATE 1 = editor, STATE 2 = confirmation. Initialized after manifest fetch.
  const [view, setView] = useState<'editor' | 'confirmation'>('editor');
  // Tracks whether we've completed the initial view decision (post-fetch).
  const [initialized, setInitialized] = useState(false);

  const { data: cylTypes } = useQuery({
    queryKey: ['cylinder-types-list'],
    queryFn: () => apiGet<{ cylinderTypes: CylinderTypeRow[] }>('/cylinder-types'),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });
  const types = useMemo(() => cylTypes?.cylinderTypes ?? [], [cylTypes]);

  const { data: existing, isLoading: manifestLoading, isSuccess: manifestLoaded } = useQuery({
    queryKey: ['manifest', assignmentId, tripNumber],
    queryFn: () =>
      apiGet<{ manifest: ManifestRow[] }>(`/manifests/dva/${assignmentId}`),
    enabled: open && !!assignmentId,
    staleTime: 30_000,
  });
  const existingRows = existing?.manifest ?? [];
  const existingByType = useMemo(
    () => new Map(existingRows.map((m) => [m.cylinderTypeId, m])),
    [existingRows],
  );

  // Live ordered count from passed orderItems — fallback before any manifest
  // is confirmed.
  const liveOrderedByType = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of orderItems) {
      m.set(it.cylinderTypeId, (m.get(it.cylinderTypeId) ?? 0) + it.quantity);
    }
    return m;
  }, [orderItems]);

  // Decide initial view as soon as the manifest fetch settles. Re-runs each
  // open (initialized resets on close — see effect below).
  if (open && manifestLoaded && !initialized) {
    setView(existingRows.length > 0 ? 'confirmation' : 'editor');
    setInitialized(true);
  }
  // Reset when the modal is closed so a re-open re-evaluates.
  if (!open && initialized) {
    setInitialized(false);
    setSpareByType({});
    setView('editor');
  }

  const saveMutation = useMutation({
    mutationFn: (items: Array<{ cylinderTypeId: string; totalLoaded: number }>) =>
      apiPost<{ manifest: ManifestRow[] }>('/manifests', { dvaId: assignmentId, items }),
    onSuccess: (saved) => {
      toast.success('Load list saved');
      // Optimistic merge into cache so the confirmation view renders
      // immediately with the just-saved values.
      if (saved && Array.isArray(saved.manifest)) {
        queryClient.setQueryData<{ manifest: ManifestRow[] }>(
          ['manifest', assignmentId, tripNumber],
          (prev) => {
            const merged = new Map<string, ManifestRow>();
            for (const m of prev?.manifest ?? []) merged.set(m.cylinderTypeId, m);
            for (const m of saved.manifest) merged.set(m.cylinderTypeId, m);
            return { manifest: Array.from(merged.values()) };
          },
        );
      }
      queryClient.invalidateQueries({ queryKey: ['manifest', assignmentId, tripNumber] });
      setSpareByType({});
      setView('confirmation');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err) ?? 'Failed to save load list');
    },
  });

  const handleSave = () => {
    // Build payload from rows where the admin either typed a value OR an
    // existing saved spare is being implicitly re-confirmed via Save.
    // Empty rows with 0 booked + 0 saved spare → omitted (zero-total rows
    // add noise; createManifestSchema requires ≥1 item).
    const items: Array<{ cylinderTypeId: string; totalLoaded: number }> = [];
    for (const t of types) {
      const raw = spareByType[t.cylinderTypeId];
      const saved = existingByType.get(t.cylinderTypeId);
      const savedSpare = saved?.floatQty ?? 0;
      const explicit = raw !== undefined && raw.trim() !== '';
      const spareVal = explicit ? Math.max(0, Math.floor(Number(raw) || 0)) : savedSpare;
      const ordered = saved?.orderedQty ?? liveOrderedByType.get(t.cylinderTypeId) ?? 0;
      const totalLoaded = ordered + spareVal;
      if (!explicit && savedSpare === 0 && ordered === 0) continue;
      if (totalLoaded <= 0) continue;
      items.push({ cylinderTypeId: t.cylinderTypeId, totalLoaded });
    }
    if (items.length === 0) {
      toast.error('Enter spare qty for at least one cylinder type');
      return;
    }
    saveMutation.mutate(items);
  };

  const handleEdit = () => {
    setSpareByType({});
    setView('editor');
  };

  const totalToLoadInEditor = useMemo(() => {
    let sum = 0;
    for (const t of types) {
      const saved = existingByType.get(t.cylinderTypeId);
      const ordered = saved?.orderedQty ?? liveOrderedByType.get(t.cylinderTypeId) ?? 0;
      const raw = spareByType[t.cylinderTypeId];
      const savedSpare = saved?.floatQty ?? 0;
      const spareVal = raw !== undefined && raw.trim() !== ''
        ? Math.max(0, Math.floor(Number(raw) || 0))
        : savedSpare;
      sum += ordered + spareVal;
    }
    return sum;
  }, [types, existingByType, liveOrderedByType, spareByType]);

  const confirmedTotal = existingRows.reduce((s, m) => s + m.totalLoaded, 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={view === 'confirmation' ? 'Load List Confirmed' : 'Load List'}
      size="lg"
    >
      <div className="space-y-4">
        {/* Header — driver + vehicle context (always visible). */}
        <div className="flex flex-col gap-1">
          <div className="text-sm font-medium text-surface-900 dark:text-white">{driverName}</div>
          {vehicleNumber ? (
            <div className="text-xs text-surface-500 dark:text-surface-400">{vehicleNumber}</div>
          ) : (
            <div className="text-xs text-amber-600">No vehicle assigned for today</div>
          )}
        </div>

        {manifestLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader />
          </div>
        )}

        {!manifestLoading && view === 'editor' && (
          <div className="space-y-3">
            <p className="text-xs text-surface-500 dark:text-surface-400">
              Spare = extra cylinders loaded for walk-in customers (beyond booked qty).
              Total = booked + spare, debits depot at dispatch.
            </p>
            <div className="grid gap-2">
              <div className="grid grid-cols-4 gap-2 text-xs text-surface-500 dark:text-surface-400 font-medium">
                <div>Cylinder Type</div>
                <div className="text-right">Booked</div>
                <div className="text-right">Spare</div>
                <div className="text-right">Total to Load</div>
              </div>
              {types.map((t) => {
                const saved = existingByType.get(t.cylinderTypeId);
                const ordered = saved?.orderedQty ?? liveOrderedByType.get(t.cylinderTypeId) ?? 0;
                const savedSpare = saved?.floatQty ?? 0;
                const inputRaw = spareByType[t.cylinderTypeId] ?? '';
                const inputNum = inputRaw === '' ? null : Math.max(0, Math.floor(Number(inputRaw) || 0));
                const totalDisplay = ordered + (inputNum ?? savedSpare);
                return (
                  <div key={t.cylinderTypeId} className="grid grid-cols-4 gap-2 items-center">
                    <div className="text-sm text-surface-900 dark:text-white">{t.typeName}</div>
                    <div className="text-right text-sm text-surface-600 dark:text-surface-300">
                      {ordered}
                    </div>
                    <input
                      type="number"
                      min={0}
                      value={inputRaw}
                      placeholder={savedSpare > 0 ? String(savedSpare) : '0'}
                      onChange={(e) =>
                        setSpareByType((prev) => ({ ...prev, [t.cylinderTypeId]: e.target.value }))
                      }
                      className="input py-1 text-sm w-full text-right"
                    />
                    <div className="text-right text-sm font-medium text-surface-900 dark:text-white">
                      {totalDisplay}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-surface-200 dark:border-surface-700 pt-3 flex items-center justify-between">
              <div className="text-sm text-surface-700 dark:text-surface-200">
                Total cylinders to load:{' '}
                <span className="font-semibold text-surface-900 dark:text-white">
                  {totalToLoadInEditor}
                </span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={onClose} disabled={saveMutation.isPending}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? 'Saving…' : 'Save Load List'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {!manifestLoading && view === 'confirmation' && (
          <div className="space-y-3">
            <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 px-3 py-2">
              <div className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                Load List Confirmed ✓
              </div>
              <div className="text-xs text-emerald-700/80 dark:text-emerald-300/80 mt-0.5">
                {confirmedTotal} cylinder{confirmedTotal === 1 ? '' : 's'} ready
              </div>
            </div>
            <div className="grid gap-1.5">
              {existingRows.map((m) => (
                <div key={m.cylinderTypeId} className="grid grid-cols-2 gap-2 text-sm">
                  <div className="text-surface-900 dark:text-white">
                    {m.cylinderTypeName ?? m.cylinderTypeId}
                  </div>
                  <div className="text-right text-surface-700 dark:text-surface-200">
                    {m.orderedQty} booked + {m.floatQty} spare ={' '}
                    <span className="font-semibold">{m.totalLoaded}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-surface-200 dark:border-surface-700 pt-3 flex items-center justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={handleEdit}>
                Edit Load List
              </Button>
              <Button size="sm" onClick={onDispatchNow}>
                Dispatch Now
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
