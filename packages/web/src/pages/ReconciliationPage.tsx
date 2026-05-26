import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { Button, Loader, EmptyState, Badge } from '@/components/ui';
import toast from 'react-hot-toast';

interface ReconciliationVehicle {
  vehicleId: string;
  vehicleNumber: string;
  pendingCancelledStock: number;
  pendingUndeliveredOrders: number;
}

interface ReconciliationConfirmInput {
  physicalStockConfirmed: boolean;
  notes?: string;
}

interface ReconciliationConfirmResult {
  cancelledStockReturned: number;
  undeliveredOrdersCancelled: number;
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
        `Reconciliation complete: ${result.cancelledStockReturned} stock returned, ${result.undeliveredOrdersCancelled} orders cancelled`,
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
            <div
              key={v.vehicleId}
              className="bg-white dark:bg-surface-800 rounded-xl p-6 shadow-sm"
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold">{v.vehicleNumber}</h3>
                  <p className="text-sm text-surface-500">
                    {v.pendingCancelledStock} cancelled stock +{' '}
                    {v.pendingUndeliveredOrders} undelivered orders
                  </p>
                </div>
                <Badge variant="warning">Pending Verification</Badge>
              </div>
              <div className="flex gap-3">
                <Button
                  onClick={() =>
                    confirm.mutate({
                      vehicleId: v.vehicleId,
                      data: {
                        physicalStockConfirmed: true,
                        notes: 'Physical stock matches system',
                      },
                    })
                  }
                  disabled={confirm.isPending}
                >
                  Confirm Physical Stock Matches
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    confirm.mutate({
                      vehicleId: v.vehicleId,
                      data: {
                        physicalStockConfirmed: false,
                        notes: 'Stock mismatch detected',
                      },
                    })
                  }
                  disabled={confirm.isPending}
                >
                  Report Mismatch
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
