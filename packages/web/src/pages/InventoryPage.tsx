import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import {
  HiOutlineChevronLeft,
  HiOutlineChevronRight,
  HiOutlineLockClosed,
  HiOutlineLockOpen,
  HiOutlinePlus,
  HiOutlineArrowUturnLeft,
} from 'react-icons/hi2';
import {
  type InventorySummary,
  type InventoryEvent,
  type CancelledStock,
  type CustomerInventoryBalance,
  type InventoryForecast,
  type CylinderType,
  type Vehicle,
  type PaginationMeta,
  incomingFullsSchema,
  type IncomingFullsInput,
  outgoingEmptiesSchema,
  type OutgoingEmptiesInput,
  CancelledStockStatus,
} from '@gaslink/shared';
import { apiGet, apiPost, apiPut, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';

function todayString(): string {
  return new Date().toISOString().split('T')[0];
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

export default function InventoryPage() {
  const queryClient = useQueryClient();
  const [selectedDate, setSelectedDate] = useState(todayString());
  const [tab, setTab] = useState<'daily' | 'depot' | 'cancelled' | 'forecast' | 'customer' | 'reconciliation'>('daily');
  const [incomingOpen, setIncomingOpen] = useState(false);
  const [outgoingOpen, setOutgoingOpen] = useState(false);

  // Depot History state
  const [depotPage, setDepotPage] = useState(1);
  const [depotEventType, setDepotEventType] = useState<'' | 'incoming_fulls' | 'outgoing_empties'>('');
  const [depotDateFrom, setDepotDateFrom] = useState('');
  const [depotDateTo, setDepotDateTo] = useState('');

  const { data: inventory, isLoading } = useQuery({
    queryKey: ['inventory', selectedDate],
    queryFn: () => apiGet<InventorySummary[]>(`/inventory/summary/${selectedDate}`),
  });

  const { data: cancelledStock, isLoading: cancelledLoading } = useQuery({
    queryKey: ['cancelled-stock', selectedDate],
    queryFn: () => apiGet<CancelledStock[]>('/inventory/cancelled-stock', { date: selectedDate }),
    enabled: tab === 'cancelled',
  });

  const { data: forecast, isLoading: forecastLoading } = useQuery({
    queryKey: ['inventory-forecast'],
    queryFn: () => apiGet<InventoryForecast[]>('/inventory/forecast'),
    enabled: tab === 'forecast',
  });

  const { data: customerBalances, isLoading: customerLoading } = useQuery({
    queryKey: ['customer-balances'],
    queryFn: () => apiGet<CustomerInventoryBalance[]>('/inventory/customer-balances'),
    enabled: tab === 'customer',
  });

  const depotQueryParams: Record<string, unknown> = { page: depotPage, pageSize: 20 };
  if (depotEventType) depotQueryParams.eventType = depotEventType;
  if (depotDateFrom) depotQueryParams.dateFrom = depotDateFrom;
  if (depotDateTo) depotQueryParams.dateTo = depotDateTo;

  const { data: depotHistory, isLoading: depotLoading } = useQuery({
    queryKey: ['depot-history', depotQueryParams],
    queryFn: () => apiGet<{ events: InventoryEvent[]; meta: PaginationMeta }>('/inventory/depot-history', depotQueryParams),
    enabled: tab === 'depot',
  });

  const depotEvents = depotHistory?.events ?? [];
  const depotMeta = depotHistory?.meta;

  const { data: reconciliationVehicles, isLoading: reconciliationLoading } = useQuery({
    queryKey: ['reconciliation-pending'],
    queryFn: () => apiGet<Array<{ vehicleId: string; vehicleNumber: string; pendingCancelledStock: number; pendingUndeliveredOrders: number }>>('/delivery/reconciliation/pending'),
    enabled: tab === 'reconciliation',
  });

  const reconciliationConfirm = useMutation({
    mutationFn: ({
      vehicleId,
      data,
    }: {
      vehicleId: string;
      data: any;
    }) => apiPost(`/delivery/reconciliation/confirm/${vehicleId}`, data),
    onSuccess: (result: any) => {
      toast.success(
        `Reconciliation complete: ${result.cancelledStockReturned} stock returned, ${result.undeliveredOrdersCancelled} orders cancelled`,
      );
      queryClient.invalidateQueries({ queryKey: ['reconciliation-pending'] });
    },
    onError: (err: any) => toast.error(getErrorMessage(err)),
  });

  const { data: cylinderTypes } = useQuery({
    queryKey: ['cylinder-types'],
    queryFn: () => apiGet<{ cylinderTypes: CylinderType[] }>('/cylinder-types'),
    select: (data) => data.cylinderTypes,
    staleTime: 10 * 60 * 1000,
  });

  const { data: vehicles } = useQuery({
    queryKey: ['vehicles-list'],
    queryFn: () => apiGet<{ vehicles: Vehicle[] }>('/vehicles'),
    staleTime: 5 * 60 * 1000,
  });

  const lockMutation = useMutation({
    mutationFn: () => apiPut(`/inventory/lock-summary`, { date: selectedDate }),
    onSuccess: () => {
      toast.success('Day locked');
      queryClient.invalidateQueries({ queryKey: ['inventory', selectedDate] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const unlockMutation = useMutation({
    mutationFn: () => apiPost(`/inventory/unlock`, { date: selectedDate }),
    onSuccess: () => {
      toast.success('Day unlocked');
      queryClient.invalidateQueries({ queryKey: ['inventory', selectedDate] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const returnToDepotMutation = useMutation({
    mutationFn: (eventIds: string[]) =>
      apiPost('/inventory/cancelled-stock/return', { eventIds, returnDate: todayString() }),
    onSuccess: () => {
      toast.success('Stock returned to depot');
      queryClient.invalidateQueries({ queryKey: ['cancelled-stock'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const isLocked = inventory?.[0]?.isLocked ?? false;
  const isToday = selectedDate === todayString();

  const tabs = [
    { key: 'daily' as const, label: 'Daily Summary' },
    { key: 'depot' as const, label: 'Depot History' },
    { key: 'cancelled' as const, label: 'Cancelled Stock' },
    { key: 'forecast' as const, label: 'Forecast' },
    { key: 'customer' as const, label: 'Customer Balances' },
    { key: 'reconciliation' as const, label: 'Reconciliation' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Inventory</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Track cylinder stock levels</p>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'daily' && !isLocked && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setIncomingOpen(true)}>
                <HiOutlinePlus className="h-4 w-4" />Incoming Fulls
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setOutgoingOpen(true)}>
                <HiOutlinePlus className="h-4 w-4" />Outgoing Empties
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Date Navigation */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSelectedDate(addDays(selectedDate, -1))}
              className="p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700"
            >
              <HiOutlineChevronLeft className="h-5 w-5" />
            </button>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="input py-2 w-auto"
            />
            <button
              onClick={() => setSelectedDate(addDays(selectedDate, 1))}
              className="p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700"
            >
              <HiOutlineChevronRight className="h-5 w-5" />
            </button>
            {!isToday && (
              <Button variant="ghost" size="sm" onClick={() => setSelectedDate(todayString())}>
                Today
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isLocked ? (
              <Button variant="secondary" size="sm" onClick={() => unlockMutation.mutate()} loading={unlockMutation.isPending}>
                <HiOutlineLockOpen className="h-4 w-4" />Unlock Day
              </Button>
            ) : (
              <Button
                variant="accent"
                size="sm"
                onClick={() => {
                  // Locking a day freezes all of that day's inventory
                  // summaries — an admin has to explicitly unlock to edit
                  // again. Confirm before doing it.
                  if (window.confirm(
                    `Lock inventory for ${selectedDate}? All summaries for this day will be frozen and can only be changed after an admin unlocks the day.`
                  )) {
                    lockMutation.mutate();
                  }
                }}
                loading={lockMutation.isPending}
              >
                <HiOutlineLockClosed className="h-4 w-4" />Lock Day
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-surface-200 dark:border-surface-700">
        <div className="flex gap-4">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'pb-2 text-sm font-medium border-b-2 transition-colors',
                tab === t.key
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {tab === 'daily' && (
        isLoading ? (
          <div className="flex justify-center py-20"><Loader size="lg" /></div>
        ) : !inventory?.length ? (
          <EmptyState title="No inventory data" description="No inventory data for this date." />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {inventory.map((item) => {
              const isWarning = item.thresholdWarning !== null && item.closingFulls <= item.thresholdWarning;
              const isCritical = item.thresholdCritical !== null && item.closingFulls <= item.thresholdCritical;
              return (
                <div
                  key={item.cylinderTypeId}
                  className={cn(
                    'card p-5 space-y-4',
                    isCritical && 'ring-2 ring-red-500/50',
                    isWarning && !isCritical && 'ring-2 ring-amber-500/50',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-surface-900 dark:text-white">{item.cylinderTypeName}</h3>
                    <div className="flex gap-1">
                      {isCritical && <Badge variant="danger">Critical</Badge>}
                      {isWarning && !isCritical && <Badge variant="warning">Warning</Badge>}
                      {item.isLocked && <Badge variant="neutral">Locked</Badge>}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50">
                      <p className="text-xs text-surface-400">Opening Fulls</p>
                      <p className="font-bold text-surface-900 dark:text-white text-lg">{item.openingFulls}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-accent-50 dark:bg-accent-500/10">
                      <p className="text-xs text-surface-400">Incoming Fulls</p>
                      <p className="font-bold text-accent-600 dark:text-accent-400 text-lg">+{item.incomingFulls}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-brand-50 dark:bg-brand-500/10">
                      <p className="text-xs text-surface-400">Delivered</p>
                      <p className="font-bold text-brand-600 dark:text-brand-400 text-lg">-{item.deliveredQty}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-flame-50 dark:bg-flame-500/10">
                      <p className="text-xs text-surface-400">Cancelled</p>
                      <p className="font-bold text-flame-600 dark:text-flame-400 text-lg">{item.cancelledStockQty}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50">
                      <p className="text-xs text-surface-400">Outgoing Empties</p>
                      <p className="font-bold text-surface-900 dark:text-white text-lg">{item.outgoingEmpties}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800/50">
                      <p className="text-xs text-surface-400">Collected Empties</p>
                      <p className="font-bold text-surface-900 dark:text-white text-lg">{item.collectedEmpties}</p>
                    </div>
                  </div>

                  <div className="flex justify-between pt-2 border-t border-surface-200 dark:border-surface-700">
                    <div>
                      <p className="text-xs text-surface-400">Closing Fulls</p>
                      <p className={cn('font-bold text-xl', isCritical ? 'text-red-500' : 'text-surface-900 dark:text-white')}>
                        {item.closingFulls}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-surface-400">Closing Empties</p>
                      <p className="font-bold text-xl text-surface-900 dark:text-white">{item.closingEmpties}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {tab === 'depot' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="card p-4">
            <div className="flex flex-col sm:flex-row gap-3 items-end">
              <div className="flex-1">
                <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">From Date</label>
                <input
                  type="date"
                  value={depotDateFrom}
                  onChange={(e) => { setDepotDateFrom(e.target.value); setDepotPage(1); }}
                  className="input py-2 w-full"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">To Date</label>
                <input
                  type="date"
                  value={depotDateTo}
                  onChange={(e) => { setDepotDateTo(e.target.value); setDepotPage(1); }}
                  className="input py-2 w-full"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">Event Type</label>
                <select
                  value={depotEventType}
                  onChange={(e) => { setDepotEventType(e.target.value as any); setDepotPage(1); }}
                  className="input py-2 w-full"
                >
                  <option value="">All</option>
                  <option value="incoming_fulls">Incoming Fulls</option>
                  <option value="outgoing_empties">Outgoing Empties</option>
                </select>
              </div>
              {(depotDateFrom || depotDateTo || depotEventType) && (
                <Button variant="ghost" size="sm" onClick={() => { setDepotDateFrom(''); setDepotDateTo(''); setDepotEventType(''); setDepotPage(1); }}>
                  Clear
                </Button>
              )}
            </div>
          </div>

          {/* Table */}
          {depotLoading ? (
            <div className="flex justify-center py-20"><Loader size="lg" /></div>
          ) : !depotEvents.length ? (
            <EmptyState title="No depot history" description="No incoming fulls or outgoing empties transactions found." />
          ) : (
            <>
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Cylinder Type</th>
                      <th>Qty</th>
                      <th>Vehicle No</th>
                      <th>Driver</th>
                      <th>Doc Type</th>
                      <th>Doc No</th>
                      <th>Doc Date</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {depotEvents.map((ev) => (
                      <tr key={ev.eventId}>
                        <td className="whitespace-nowrap">{new Date(ev.eventDate).toLocaleDateString('en-IN')}</td>
                        <td>
                          <Badge variant={ev.eventType === 'incoming_fulls' ? 'success' : 'warning'}>
                            {ev.eventType === 'incoming_fulls' ? 'Incoming' : 'Outgoing'}
                          </Badge>
                        </td>
                        <td className="font-medium">{ev.cylinderTypeName}</td>
                        <td>{ev.eventType === 'incoming_fulls' ? ev.quantity : ev.quantity}</td>
                        <td>{ev.vehicleNumber || '-'}</td>
                        <td>{ev.driverName || '-'}</td>
                        <td>{ev.documentType || '-'}</td>
                        <td>{ev.documentNumber || '-'}</td>
                        <td className="whitespace-nowrap">{ev.documentDate ? new Date(ev.documentDate).toLocaleDateString('en-IN') : '-'}</td>
                        <td className="max-w-[200px] truncate">{ev.notes || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {depotMeta && depotMeta.totalPages > 1 && (
                <div className="flex items-center justify-between">
                  <p className="text-sm text-surface-500 dark:text-surface-400">
                    Page {depotMeta.page} of {depotMeta.totalPages} ({depotMeta.total} total)
                  </p>
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" disabled={depotPage <= 1} onClick={() => setDepotPage(depotPage - 1)}>Previous</Button>
                    <Button variant="secondary" size="sm" disabled={depotPage >= depotMeta.totalPages} onClick={() => setDepotPage(depotPage + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'cancelled' && (
        cancelledLoading ? (
          <div className="flex justify-center py-20"><Loader size="lg" /></div>
        ) : !cancelledStock?.length ? (
          <EmptyState title="No cancelled stock" description="No cancelled stock for this date." />
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Cylinder Type</th>
                  <th>Qty</th>
                  <th>Driver</th>
                  <th>Vehicle</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {cancelledStock.map((cs) => (
                  <tr key={cs.eventId}>
                    <td className="font-medium">{cs.cylinderTypeName}</td>
                    <td>{cs.quantity}</td>
                    <td>{cs.driverName}</td>
                    <td>{cs.vehicleNumber}</td>
                    <td>
                      <Badge variant={cs.status === CancelledStockStatus.RETURNED_TO_DEPOT ? 'success' : cs.status === CancelledStockStatus.ON_VEHICLE ? 'warning' : 'neutral'}>
                        {cs.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td>
                      {(cs.status === CancelledStockStatus.ON_VEHICLE || cs.status === CancelledStockStatus.PENDING) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => returnToDepotMutation.mutate([cs.eventId])}
                          loading={returnToDepotMutation.isPending}
                        >
                          <HiOutlineArrowUturnLeft className="h-3 w-3" />
                          Return
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === 'forecast' && (
        forecastLoading ? (
          <div className="flex justify-center py-20"><Loader size="lg" /></div>
        ) : !forecast?.length ? (
          <EmptyState title="No forecast data" />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {forecast.map((f) => (
              <div key={f.cylinderTypeId} className="card p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-surface-900 dark:text-white">{f.cylinderTypeName}</h3>
                  <Badge variant={f.trendDirection === 'increasing' ? 'danger' : f.trendDirection === 'decreasing' ? 'success' : 'neutral'}>
                    {f.trendDirection}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div><p className="text-xs text-surface-400">Current Stock</p><p className="font-bold text-lg text-surface-900 dark:text-white">{f.currentStock}</p></div>
                  <div><p className="text-xs text-surface-400">Avg Daily Demand</p><p className="font-bold text-lg text-surface-900 dark:text-white">{f.averageDailyDemand.toFixed(1)}</p></div>
                  <div><p className="text-xs text-surface-400">Days Remaining</p><p className="font-bold text-lg text-surface-900 dark:text-white">{f.daysOfStockRemaining}</p></div>
                  <div><p className="text-xs text-surface-400">Reorder Qty</p><p className="font-bold text-lg text-brand-600 dark:text-brand-400">{f.recommendedReorderQty}</p></div>
                  <div><p className="text-xs text-surface-400">7-Day Forecast</p><p className="font-medium">{f.forecastedDemand7Days}</p></div>
                  <div><p className="text-xs text-surface-400">30-Day Forecast</p><p className="font-medium">{f.forecastedDemand30Days}</p></div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'customer' && (
        customerLoading ? (
          <div className="flex justify-center py-20"><Loader size="lg" /></div>
        ) : !customerBalances?.length ? (
          <EmptyState title="No customer balances" />
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr><th>Customer</th><th>Cylinder Type</th><th>With Customer</th><th>Pending Returns</th><th>Missing</th><th>Last Updated</th></tr>
              </thead>
              <tbody>
                {customerBalances.map((b, i) => (
                  <tr key={`${b.customerId}-${b.cylinderTypeId}-${i}`}>
                    <td className="font-medium">{b.customerName}</td>
                    <td>{b.cylinderTypeName}</td>
                    <td>{b.withCustomerQty}</td>
                    <td>{b.pendingReturns}</td>
                    <td>{b.missingQty > 0 ? <span className="text-red-500 font-medium">{b.missingQty}</span> : 0}</td>
                    <td className="text-xs text-surface-400">{new Date(b.lastUpdated).toLocaleDateString('en-IN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === 'reconciliation' && (
        reconciliationLoading ? (
          <div className="flex justify-center py-20"><Loader size="lg" /></div>
        ) : !reconciliationVehicles?.length ? (
          <EmptyState
            title="No vehicles pending"
            description="All returned vehicles have been reconciled"
          />
        ) : (
          <div className="grid gap-4">
            {reconciliationVehicles.map((v: any) => (
              <div
                key={v.vehicleId}
                className="bg-white dark:bg-surface-800 rounded-xl p-6 shadow-sm"
              >
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold">{v.vehicleNumber}</h3>
                    <p className="text-sm text-surface-500">
                      {v.pendingCancelledStock} cancelled stock + {v.pendingUndeliveredOrders} undelivered orders
                    </p>
                  </div>
                  <Badge variant="warning">Pending Verification</Badge>
                </div>
                <div className="flex gap-3">
                  <Button
                    onClick={() =>
                      reconciliationConfirm.mutate({
                        vehicleId: v.vehicleId,
                        data: {
                          physicalStockConfirmed: true,
                          notes: 'Physical stock matches system',
                        },
                      })
                    }
                    disabled={reconciliationConfirm.isPending}
                  >
                    Confirm Physical Stock Matches
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      reconciliationConfirm.mutate({
                        vehicleId: v.vehicleId,
                        data: {
                          physicalStockConfirmed: false,
                          notes: 'Stock mismatch detected',
                        },
                      })
                    }
                    disabled={reconciliationConfirm.isPending}
                  >
                    Report Mismatch
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Incoming Fulls Modal */}
      {incomingOpen && (
        <IncomingFullsModal
          open={incomingOpen}
          onClose={() => setIncomingOpen(false)}
          cylinderTypes={cylinderTypes ?? []}
          vehicles={vehicles?.vehicles ?? []}
          date={selectedDate}
        />
      )}

      {/* Outgoing Empties Modal */}
      {outgoingOpen && (
        <OutgoingEmptiesModal
          open={outgoingOpen}
          onClose={() => setOutgoingOpen(false)}
          cylinderTypes={cylinderTypes ?? []}
          vehicles={vehicles?.vehicles ?? []}
          date={selectedDate}
        />
      )}
    </div>
  );
}

// ─── Incoming Fulls Modal ────────────────────────────────────────────────────

function IncomingFullsModal({
  open,
  onClose,
  cylinderTypes,
  vehicles,
  date,
}: {
  open: boolean;
  onClose: () => void;
  cylinderTypes: CylinderType[];
  vehicles: Vehicle[];
  date: string;
}) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, formState: { errors } } = useForm<IncomingFullsInput>({
    resolver: zodResolver(incomingFullsSchema),
    defaultValues: { cylinderTypeId: '', quantity: 1, documentType: '', documentNumber: '', documentDate: date },
  });

  const mutation = useMutation({
    mutationFn: (data: IncomingFullsInput) => apiPost('/inventory/incoming-fulls', data),
    onSuccess: () => {
      toast.success('Incoming fulls recorded');
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: ct.typeName }));
  const vehicleOptions = vehicles.map((v) => ({ value: v.vehicleId, label: v.vehicleNumber }));

  return (
    <Modal open={open} onClose={onClose} title="Record Incoming Fulls">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Select label="Cylinder Type" options={cylinderOptions} placeholder="Select type" required error={errors.cylinderTypeId?.message} {...register('cylinderTypeId')} />
        <Input label="Quantity" type="number" min={1} required error={errors.quantity?.message} {...register('quantity', { valueAsNumber: true })} />
        <Input label="Document Type" placeholder="e.g. Delivery Challan" required error={errors.documentType?.message} {...register('documentType')} />
        <Input label="Document Number" required error={errors.documentNumber?.message} {...register('documentNumber')} />
        <Input label="Document Date" type="date" required error={errors.documentDate?.message} {...register('documentDate')} />
        <Select label="Vehicle (Optional)" options={vehicleOptions} placeholder="Select vehicle" {...register('vehicleId')} />
        <Input label="Vehicle Number" placeholder="e.g. KA-01-AB-1234" {...register('vehicleNumber')} />
        <Input label="Driver Name" placeholder="e.g. Raju" {...register('driverName')} />
        <Input label="Notes" placeholder="Optional notes" {...register('notes')} />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Record</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Outgoing Empties Modal ──────────────────────────────────────────────────

function OutgoingEmptiesModal({
  open,
  onClose,
  cylinderTypes,
  vehicles,
  date,
}: {
  open: boolean;
  onClose: () => void;
  cylinderTypes: CylinderType[];
  vehicles: Vehicle[];
  date: string;
}) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, formState: { errors } } = useForm<OutgoingEmptiesInput>({
    resolver: zodResolver(outgoingEmptiesSchema),
    defaultValues: { cylinderTypeId: '', quantity: 1, documentType: '', documentNumber: '', documentDate: date },
  });

  const mutation = useMutation({
    mutationFn: (data: OutgoingEmptiesInput) => apiPost('/inventory/outgoing-empties', data),
    onSuccess: () => {
      toast.success('Outgoing empties recorded');
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: ct.typeName }));
  const vehicleOptions = vehicles.map((v) => ({ value: v.vehicleId, label: v.vehicleNumber }));

  return (
    <Modal open={open} onClose={onClose} title="Record Outgoing Empties">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Select label="Cylinder Type" options={cylinderOptions} placeholder="Select type" required error={errors.cylinderTypeId?.message} {...register('cylinderTypeId')} />
        <Input label="Quantity" type="number" min={1} required error={errors.quantity?.message} {...register('quantity', { valueAsNumber: true })} />
        <Input label="Document Type" placeholder="e.g. Return Challan" required error={errors.documentType?.message} {...register('documentType')} />
        <Input label="Document Number" required error={errors.documentNumber?.message} {...register('documentNumber')} />
        <Input label="Document Date" type="date" required error={errors.documentDate?.message} {...register('documentDate')} />
        <Select label="Vehicle (Optional)" options={vehicleOptions} placeholder="Select vehicle" {...register('vehicleId')} />
        <Input label="Vehicle Number" placeholder="e.g. KA-01-AB-1234" {...register('vehicleNumber')} />
        <Input label="Driver Name" placeholder="e.g. Raju" {...register('driverName')} />
        <Input label="Notes" placeholder="Optional notes" {...register('notes')} />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Record</Button>
        </div>
      </form>
    </Modal>
  );
}
