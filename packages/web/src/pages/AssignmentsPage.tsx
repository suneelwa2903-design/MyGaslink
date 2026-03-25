import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
import { Button, Loader, EmptyState, Badge } from '@/components/ui';

interface VehicleMapping {
  driverId: string;
  driverName: string;
  vehicleNumber?: string;
  status: string;
  source: string;
}

interface MappingsResponse {
  recommendations: VehicleMapping[];
  confirmedCount: number;
  recommendedCount: number;
  unassignedCount: number;
}

interface PendingOrdersResponse {
  data: Array<{
    id: string;
    orderNumber: string;
    customer?: { customerName: string };
    deliveryDate?: string;
    totalAmount?: number;
  }>;
}

export default function AssignmentsPage() {
  const queryClient = useQueryClient();
  const today = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(today);
  const [tab, setTab] = useState<'mappings' | 'orders'>('mappings');

  // ─── Driver-Vehicle Mappings ───
  const { data: mappings, isLoading: mappingsLoading } = useQuery({
    queryKey: ['vehicle-mappings', selectedDate],
    queryFn: () => apiGet<MappingsResponse>(`/assignments/vehicle-mappings?date=${selectedDate}`),
  });

  const confirmMappings = useMutation({
    mutationFn: (data: { date: string; mappings?: any[] }) =>
      apiPost('/assignments/vehicle-mappings/confirm', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicle-mappings'] });
    },
  });

  // ─── Order Assignment ───
  const { data: pendingOrders } = useQuery({
    queryKey: ['pending-orders'],
    queryFn: () =>
      apiGet<PendingOrdersResponse>('/orders?status=pending_driver_assignment&pageSize=100'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100">
          Daily Assignments
        </h1>
        <div className="flex gap-2">
          <button
            className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === 'mappings' ? 'bg-brand-600 text-white' : 'bg-surface-100 dark:bg-surface-800'}`}
            onClick={() => setTab('mappings')}
          >
            Vehicle Mappings
          </button>
          <button
            className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === 'orders' ? 'bg-brand-600 text-white' : 'bg-surface-100 dark:bg-surface-800'}`}
            onClick={() => setTab('orders')}
          >
            Order Assignment
          </button>
        </div>
      </div>

      {tab === 'mappings' && (
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="px-3 py-2 border rounded-lg dark:bg-surface-800 dark:border-surface-700"
            />
            <Button
              onClick={() =>
                confirmMappings.mutate({ date: selectedDate })
              }
              disabled={confirmMappings.isPending}
            >
              {confirmMappings.isPending
                ? 'Confirming...'
                : 'Bulk Confirm All (Use Previous Day)'}
            </Button>
          </div>

          {mappingsLoading ? (
            <Loader />
          ) : !mappings?.recommendations?.length ? (
            <EmptyState
              title="No mappings"
              description="No driver-vehicle mappings for this date"
            />
          ) : (
            <div className="bg-white dark:bg-surface-800 rounded-xl shadow-sm overflow-hidden">
              <table className="w-full">
                <thead className="bg-surface-50 dark:bg-surface-700">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Driver
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Vehicle
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Source
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-100 dark:divide-surface-700">
                  {mappings.recommendations.map((r: any) => (
                    <tr
                      key={r.driverId}
                      className="hover:bg-surface-50 dark:hover:bg-surface-700/50"
                    >
                      <td className="px-4 py-3 text-sm">{r.driverName}</td>
                      <td className="px-4 py-3 text-sm">
                        {r.vehicleNumber || '\u2014'}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            r.status === 'confirmed'
                              ? 'success'
                              : r.status === 'recommended'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {r.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-500">
                        {r.source}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-3 bg-surface-50 dark:bg-surface-700 text-sm">
                Confirmed: {mappings.confirmedCount} | Recommended:{' '}
                {mappings.recommendedCount} | Unassigned:{' '}
                {mappings.unassignedCount}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'orders' && (
        <div className="space-y-4">
          <p className="text-sm text-surface-500">
            Orders pending driver assignment. Use bulk assign to assign drivers
            based on recommendations.
          </p>
          {pendingOrders?.data?.length ? (
            <div className="bg-white dark:bg-surface-800 rounded-xl shadow-sm overflow-hidden">
              <table className="w-full">
                <thead className="bg-surface-50 dark:bg-surface-700">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Order
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Customer
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Delivery Date
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-100 dark:divide-surface-700">
                  {pendingOrders.data.map((o: any) => (
                    <tr key={o.id}>
                      <td className="px-4 py-3 text-sm font-mono">
                        {o.orderNumber}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {o.customer?.customerName}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {o.deliveryDate?.split('T')[0]}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium">
                        ₹{o.totalAmount?.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No pending orders"
              description="All orders have been assigned"
            />
          )}
        </div>
      )}
    </div>
  );
}
