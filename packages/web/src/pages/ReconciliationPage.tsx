import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { Button, Loader, EmptyState, Badge } from '@/components/ui';
import toast from 'react-hot-toast';

interface ReconciliationEmptyType {
  cylinderTypeId: string;
  typeName: string;
  collectedQty: number;
}

interface ReconciliationVehicle {
  vehicleId: string;
  vehicleNumber: string;
  pendingCancelledStock: number;
  pendingUndeliveredOrders: number;
  emptiesTypes: ReconciliationEmptyType[];
}

interface ReconciliationConfirmInput {
  physicalStockConfirmed: boolean;
  notes?: string;
  emptiesReturned?: { cylinderTypeId: string; quantity: number }[];
}

interface ReconciliationConfirmResult {
  cancelledStockReturned: number;
  undeliveredOrdersCancelled: number;
  emptiesReturned?: number;
}

export default function ReconciliationPage() {
  const queryClient = useQueryClient();

  const { data: vehicles, isLoading } = useQuery({
    queryKey: ['reconciliation-pending'],
    queryFn: () => apiGet<ReconciliationVehicle[]>('/delivery/reconciliation/pending'),
  });

  const confirm = useMutation({
    mutationFn: ({
      vehicleId,
      data,
    }: {
      vehicleId: string;
      data: ReconciliationConfirmInput;
    }) => apiPost<ReconciliationConfirmResult>(`/delivery/reconciliation/confirm/${vehicleId}`, data),
    onSuccess: (result) => {
      toast.success(
        `Reconciliation complete: ${result.cancelledStockReturned} stock returned, ${result.undeliveredOrdersCancelled} orders cancelled, ${result.emptiesReturned ?? 0} empties verified`,
      );
      queryClient.invalidateQueries({ queryKey: ['reconciliation-pending'] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100">
        Vehicle Reconciliation
      </h1>
      <p className="text-surface-500">
        Verify returned vehicles have correct physical stock before marking
        reconciled.
      </p>

      {isLoading ? (
        <Loader />
      ) : !vehicles?.length ? (
        <EmptyState
          title="No vehicles pending"
          description="All returned vehicles have been reconciled"
        />
      ) : (
        <div className="grid gap-4">
          {vehicles.map((v) => (
            <ReconciliationCard
              key={v.vehicleId}
              vehicle={v}
              isPending={confirm.isPending}
              onConfirm={(data) => confirm.mutate({ vehicleId: v.vehicleId, data })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReconciliationCard({
  vehicle,
  isPending,
  onConfirm,
}: {
  vehicle: ReconciliationVehicle;
  isPending: boolean;
  onConfirm: (data: ReconciliationConfirmInput) => void;
}) {
  // Step 1 = confirm fulls; Step 2 = empties returned to depot (optional).
  const [step, setStep] = useState<1 | 2>(1);
  const [empties, setEmpties] = useState<Record<string, number>>(() =>
    Object.fromEntries(vehicle.emptiesTypes.map((t) => [t.cylinderTypeId, t.collectedQty])),
  );

  const setQty = (id: string, value: string) => {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    setEmpties((prev) => ({ ...prev, [id]: n }));
  };

  const submit = () => {
    const emptiesReturned = vehicle.emptiesTypes
      .map((t) => ({ cylinderTypeId: t.cylinderTypeId, quantity: empties[t.cylinderTypeId] ?? 0 }))
      .filter((e) => e.quantity > 0);
    onConfirm({
      physicalStockConfirmed: true,
      notes: 'Physical stock matches system',
      emptiesReturned,
    });
  };

  return (
    <div className="bg-white dark:bg-surface-800 rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold">{vehicle.vehicleNumber}</h3>
          <p className="text-sm text-surface-500">
            {vehicle.pendingCancelledStock} cancelled stock +{' '}
            {vehicle.pendingUndeliveredOrders} undelivered orders
          </p>
        </div>
        <Badge variant="warning">Pending Verification</Badge>
      </div>

      {step === 1 ? (
        <div className="flex gap-3">
          <Button
            onClick={() => {
              if (vehicle.emptiesTypes.length > 0) setStep(2);
              else submit();
            }}
            disabled={isPending}
          >
            Confirm Physical Stock Matches
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              onConfirm({
                physicalStockConfirmed: false,
                notes: 'Stock mismatch detected',
              })
            }
            disabled={isPending}
          >
            Report Mismatch
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <h4 className="font-medium text-surface-800 dark:text-surface-200">
              Empties Returned to Depot
            </h4>
            <p className="text-xs text-surface-500">
              Pre-filled with empties collected during deliveries. Adjust to the
              physically verified count, or leave/clear to skip — this step is
              optional and does not block reconciliation.
            </p>
          </div>
          <div className="grid gap-2 max-w-md">
            {vehicle.emptiesTypes.map((t) => (
              <div key={t.cylinderTypeId} className="flex items-center justify-between gap-3">
                <label className="text-sm text-surface-700 dark:text-surface-300">
                  {t.typeName}
                  <span className="text-xs text-surface-400"> (collected {t.collectedQty})</span>
                </label>
                <input
                  type="number"
                  min={0}
                  value={empties[t.cylinderTypeId] ?? 0}
                  onChange={(e) => setQty(t.cylinderTypeId, e.target.value)}
                  className="input py-1.5 text-sm w-24 text-right"
                />
              </div>
            ))}
          </div>
          <div className="flex gap-3">
            <Button onClick={submit} disabled={isPending}>
              Confirm & Reconcile
            </Button>
            <Button variant="secondary" onClick={() => setStep(1)} disabled={isPending}>
              Back
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
