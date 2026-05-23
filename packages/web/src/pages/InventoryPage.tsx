import { useState, useMemo } from 'react';
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
  HiOutlineAdjustmentsHorizontal,
  HiOutlineArrowTrendingUp,
  HiOutlineArrowTrendingDown,
  HiOutlineArrowRight,
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
  type ManualAdjustmentInput,
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
  // WI-080 FIX2: allow deep-linking to a tab via ?tab= (e.g. the
  // "AI Demand Forecast" header button → /app/inventory?tab=forecast).
  const initialTab = (typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('tab')
    : null) as ('daily' | 'depot' | 'onboarding' | 'cancelled' | 'forecast' | 'customer' | 'reconciliation') | null;
  const validTabs = ['daily', 'depot', 'onboarding', 'cancelled', 'forecast', 'customer', 'reconciliation'];
  const [tab, setTab] = useState<'daily' | 'depot' | 'onboarding' | 'cancelled' | 'forecast' | 'customer' | 'reconciliation'>(
    initialTab && validTabs.includes(initialTab) ? initialTab : 'daily',
  );
  const [incomingOpen, setIncomingOpen] = useState(false);
  const [outgoingOpen, setOutgoingOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);

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
    queryKey: ['cancelled-stock'],
    queryFn: () => apiGet<CancelledStock[]>('/inventory/cancelled-stock'),
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

  // WI-080 F5: opening stock recorded at onboarding (read-only).
  const { data: onboardingStock, isLoading: onboardingLoading } = useQuery({
    queryKey: ['onboarding-stock'],
    queryFn: () => apiGet<Array<{ cylinderTypeId: string; cylinderTypeName: string; openingFulls: number; openingEmpties: number; dateSet: string }>>('/inventory/onboarding-stock'),
    enabled: tab === 'onboarding',
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

  const adjustMutation = useMutation({
    mutationFn: (data: ManualAdjustmentInput) => apiPost('/inventory/manual-adjustment', data),
    onSuccess: () => {
      toast.success('Stock adjusted');
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      setAdjustOpen(false);
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const isLocked = inventory?.[0]?.isLocked ?? false;
  const isToday = selectedDate === todayString();

  // WI-080 F4 rename + F5 new tab (Stock at Onboarding, after Depot History).
  const tabs = [
    { key: 'daily' as const, label: 'Daily Summary' },
    { key: 'depot' as const, label: 'Depot History' },
    { key: 'onboarding' as const, label: 'Stock at Onboarding' },
    { key: 'cancelled' as const, label: 'Undelivered Stock' },
    { key: 'forecast' as const, label: 'AI Demand Forecast' },
    { key: 'customer' as const, label: 'Customer Balances' },
    { key: 'reconciliation' as const, label: 'Vehicle Return' },
  ];

  return (
    <div className="space-y-6 w-full">
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
              <Button variant="secondary" size="sm" onClick={() => setAdjustOpen(true)}>
                <HiOutlineAdjustmentsHorizontal className="h-4 w-4" />Adjust Stock
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
        <div className="flex gap-6">
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
          // WI-080: full ledger columns. The two depot-movement columns
          // (Incoming Fulls / Outgoing Empties) are grouped under a pastel
          // green "Depot" header. All numerics centre-aligned.
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th rowSpan={2} className="align-bottom">Cylinder Type</th>
                  <th colSpan={2} className="text-center bg-[#dcfce7] dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300">Depot</th>
                  <th rowSpan={2} className="text-center align-bottom">Opening Fulls</th>
                  <th rowSpan={2} className="text-center align-bottom">Opening Empties</th>
                  <th rowSpan={2} className="text-center align-bottom">Dispatched</th>
                  <th rowSpan={2} className="text-center align-bottom">Delivered<br /><span className="text-[10px] font-normal opacity-70">(to customer)</span></th>
                  <th rowSpan={2} className="text-center align-bottom">Collected Empties</th>
                  <th rowSpan={2} className="text-center align-bottom">Returned</th>
                  <th rowSpan={2} className="text-center align-bottom">Manual Adj</th>
                  <th rowSpan={2} className="text-center align-bottom">Closing Fulls</th>
                  <th rowSpan={2} className="text-center align-bottom">Closing Empties</th>
                  <th rowSpan={2} className="align-bottom">Status</th>
                </tr>
                <tr>
                  <th className="text-center bg-[#dcfce7] dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300">Incoming Fulls</th>
                  <th className="text-center bg-[#dcfce7] dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300">Outgoing Empties</th>
                </tr>
              </thead>
              <tbody>
                {inventory.map((item) => {
                  const isWarning = item.thresholdWarning !== null && item.closingFulls <= item.thresholdWarning;
                  const isCritical = item.thresholdCritical !== null && item.closingFulls <= item.thresholdCritical;
                  // Sign-guarded so a zero renders "0" (not "+0"/"-0").
                  const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `${n}` : '0');
                  return (
                    <tr key={item.cylinderTypeId}>
                      <td className="font-medium text-surface-900 dark:text-white">{item.cylinderTypeName}</td>
                      <td className="text-center bg-[#dcfce7]/40 dark:bg-emerald-900/20 text-accent-700 dark:text-accent-400">
                        {item.incomingFulls > 0 ? `+${item.incomingFulls}` : '0'}
                      </td>
                      <td className="text-center bg-[#dcfce7]/40 dark:bg-emerald-900/20">
                        {item.outgoingEmpties > 0 ? `${item.outgoingEmpties}` : '0'}
                      </td>
                      <td className="text-center">{item.openingFulls}</td>
                      <td className="text-center">{item.openingEmpties}</td>
                      <td className="text-center text-amber-600 dark:text-amber-400">
                        {item.dispatchedQty > 0 ? `${item.dispatchedQty}` : '0'}
                      </td>
                      <td className="text-center text-brand-600 dark:text-brand-400">
                        {item.deliveredQty > 0 ? `${item.deliveredQty}` : '0'}
                      </td>
                      <td className="text-center">{item.collectedEmpties}</td>
                      <td className="text-center text-flame-600 dark:text-flame-400">{item.cancelledStockQty}</td>
                      <td className="text-center">{signed(item.manualAdjustment)}</td>
                      <td className={cn('text-center font-semibold', isCritical && 'text-red-500')}>
                        {item.closingFulls}
                      </td>
                      <td className="text-center">{item.closingEmpties}</td>
                      <td>
                        <div className="flex gap-1">
                          {isCritical && <Badge variant="danger">Critical</Badge>}
                          {isWarning && !isCritical && <Badge variant="warning">Warning</Badge>}
                          {!isCritical && !isWarning && <Badge variant="success">OK</Badge>}
                          {item.isLocked && <Badge variant="neutral">Locked</Badge>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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

      {/* WI-080 F5: read-only opening stock recorded at onboarding. */}
      {tab === 'onboarding' && (
        onboardingLoading ? (
          <div className="flex justify-center py-20"><Loader size="lg" /></div>
        ) : !onboardingStock?.length ? (
          <EmptyState title="No opening stock recorded at onboarding." description="Opening balances entered during onboarding will appear here." />
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Cylinder Type</th>
                  <th className="text-center">Opening Fulls</th>
                  <th className="text-center">Opening Empties</th>
                  <th>Date Set</th>
                </tr>
              </thead>
              <tbody>
                {onboardingStock.map((s) => (
                  <tr key={s.cylinderTypeId}>
                    <td className="font-medium text-surface-900 dark:text-white">{s.cylinderTypeName}</td>
                    <td className="text-center">{s.openingFulls}</td>
                    <td className="text-center">{s.openingEmpties}</td>
                    <td className="text-surface-500 dark:text-surface-400">{new Date(s.dateSet).toLocaleDateString('en-IN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === 'cancelled' && (
        cancelledLoading ? (
          <div className="flex justify-center py-20"><Loader size="lg" /></div>
        ) : !cancelledStock?.length ? (
          <EmptyState title="No undelivered stock" description="No undelivered stock found across all dates." />
        ) : (
          <div className="table-container">
            <p className="text-xs text-surface-500 dark:text-surface-400 px-4 pt-3 pb-1">Showing all undelivered stock across all dates</p>
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
        <div className="space-y-4">
          {/* WI-080 F3: always-visible advisory banner. */}
          <div className="rounded-lg border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 px-4 py-3 text-sm text-brand-700 dark:text-brand-300">
            <span className="font-semibold">AI Demand Forecasting</span> — Requires minimum 1 month of delivery history for reliable predictions.
          </div>
          {forecastLoading ? (
            <div className="flex justify-center py-20"><Loader size="lg" /></div>
          ) : !forecast?.length ? (
            <EmptyState title="No forecast data" />
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Cylinder Type</th>
                    <th className="text-center">Avg Daily Demand</th>
                    <th className="text-center">Current Stock</th>
                    <th className="text-center">Days Remaining</th>
                    <th className="text-center">7-Day Forecast</th>
                    <th className="text-center">30-Day Forecast</th>
                    <th className="text-center">Reorder Qty</th>
                    <th>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {forecast.map((f) => (
                    <tr key={f.cylinderTypeId}>
                      <td className="font-medium text-surface-900 dark:text-white">{f.cylinderTypeName}</td>
                      <td className="text-center">{f.averageDailyDemand.toFixed(1)}</td>
                      <td className="text-center">{f.currentStock}</td>
                      <td className="text-center">{f.daysOfStockRemaining}</td>
                      <td className="text-center">{f.forecastedDemand7Days}</td>
                      <td className="text-center">{f.forecastedDemand30Days}</td>
                      <td className="text-center font-semibold text-brand-600 dark:text-brand-400">{f.recommendedReorderQty}</td>
                      <td>
                        {f.trendDirection === 'increasing' ? (
                          <span className="inline-flex items-center gap-1 text-red-500"><HiOutlineArrowTrendingUp className="h-4 w-4" />Increasing</span>
                        ) : f.trendDirection === 'decreasing' ? (
                          <span className="inline-flex items-center gap-1 text-accent-600 dark:text-accent-400"><HiOutlineArrowTrendingDown className="h-4 w-4" />Decreasing</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-surface-500"><HiOutlineArrowRight className="h-4 w-4" />Stable</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'customer' && (
        customerLoading ? (
          <div className="flex justify-center py-20"><Loader size="lg" /></div>
        ) : (
          <CustomerBalancesTab balances={customerBalances ?? []} />
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
                    onClick={() => {
                      const pending = (v as any).pendingOrderSummaries ?? [];
                      if (pending.length > 0) {
                        const names = pending
                          .map((o: any) => `${o.orderNumber} (${o.customerName ?? 'Unknown'})`)
                          .join('\n');
                        const ok = confirm(
                          `Warning: The following orders are still pending delivery and will be force-cancelled:\n\n${names}\n\nAre you sure you want to proceed?`,
                        );
                        if (!ok) return;
                      }
                      reconciliationConfirm.mutate({
                        vehicleId: v.vehicleId,
                        data: {
                          physicalStockConfirmed: true,
                          notes: 'Physical stock matches system',
                        },
                      });
                    }}
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

      {/* WI-080 F2: Adjust Stock Modal */}
      {adjustOpen && (
        <AdjustStockModal
          open={adjustOpen}
          onClose={() => setAdjustOpen(false)}
          cylinderTypes={cylinderTypes ?? []}
          date={selectedDate}
          submitting={adjustMutation.isPending}
          onSubmit={(data) => adjustMutation.mutate(data)}
        />
      )}
    </div>
  );
}

// ─── Adjust Stock Modal (WI-080 F2) ──────────────────────────────────────────

function AdjustStockModal({
  open,
  onClose,
  cylinderTypes,
  date,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  cylinderTypes: CylinderType[];
  date: string;
  submitting: boolean;
  onSubmit: (data: ManualAdjustmentInput) => void;
}) {
  const [cylinderTypeId, setCylinderTypeId] = useState('');
  const [quantity, setQuantity] = useState<string>('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: ct.typeName }));

  const submit = () => {
    const qty = Number(quantity);
    if (!cylinderTypeId) return setError('Select a cylinder type');
    if (!Number.isFinite(qty) || qty === 0) return setError('Quantity must be a non-zero number (positive to add, negative to subtract)');
    if (!reason.trim()) return setError('Reason is required');
    setError(null);
    // API expects adjustmentType + positive quantity; map the signed input.
    onSubmit({
      cylinderTypeId,
      adjustmentType: qty > 0 ? 'add' : 'subtract',
      quantity: Math.abs(qty),
      reason: reason.trim(),
      adjustmentDate: date,
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Adjust Stock">
      <div className="space-y-4">
        <Select
          label="Cylinder Type"
          options={cylinderOptions}
          placeholder="Select type"
          required
          value={cylinderTypeId}
          onChange={(e) => setCylinderTypeId(e.target.value)}
        />
        <Input
          label="Quantity (positive = add, negative = subtract)"
          type="number"
          placeholder="e.g. 10 or -5"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
        <Input
          label="Reason"
          placeholder="Reason for adjustment"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={submit} loading={submitting}>Adjust</Button>
        </div>
      </div>
    </Modal>
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

// ─── Customer Balances Tab (WI-080 F6) ───────────────────────────────────────

type SortKey = 'customer' | 'type' | 'qty' | 'cost' | 'days';

function CustomerBalancesTab({ balances }: { balances: CustomerInventoryBalance[] }) {
  // Distinct cylinder types present (for the filter dropdown).
  const types = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of balances) if (!m.has(b.cylinderTypeId)) m.set(b.cylinderTypeId, b.cylinderTypeName);
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [balances]);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [onlyOutstanding, setOnlyOutstanding] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('customer');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const daysSince = (d?: string | null): number | null =>
    d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null;
  const money = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  const rows = useMemo(() => {
    const mapped = balances
      .filter((b) => (onlyOutstanding ? b.withCustomerQty > 0 : true))
      .filter((b) => (search ? b.customerName.toLowerCase().includes(search.toLowerCase()) : true))
      .filter((b) => (typeFilter ? b.cylinderTypeId === typeFilter : true))
      .map((b) => {
        // WI-080 amendment: empty-cylinder price now comes from the API
        // (EmptyCylinderPrice table). null when none is configured.
        const emptyPrice = b.emptyCylinderPrice ?? null;
        return {
          ...b,
          emptyPrice,
          emptyCost: emptyPrice === null ? null : b.withCustomerQty * emptyPrice,
          days: daysSince(b.lastDeliveryDate),
        };
      });
    const dir = sortDir === 'asc' ? 1 : -1;
    mapped.sort((a, b) => {
      switch (sortKey) {
        case 'customer': return a.customerName.localeCompare(b.customerName) * dir;
        case 'type': return a.cylinderTypeName.localeCompare(b.cylinderTypeName) * dir;
        case 'qty': return (a.withCustomerQty - b.withCustomerQty) * dir;
        case 'cost': return ((a.emptyCost ?? -1) - (b.emptyCost ?? -1)) * dir;
        case 'days': return ((a.days ?? -1) - (b.days ?? -1)) * dir;
        default: return 0;
      }
    });
    return mapped;
  }, [balances, onlyOutstanding, search, typeFilter, sortKey, sortDir]);

  const totalQty = rows.reduce((s, r) => s + r.withCustomerQty, 0);
  const totalCost = rows.reduce((s, r) => s + (r.emptyCost ?? 0), 0);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };
  const SortTh = ({ k, label, center }: { k: SortKey; label: string; center?: boolean }) => (
    <th
      className={cn('cursor-pointer select-none hover:text-brand-600', center && 'text-center')}
      onClick={() => toggleSort(k)}
    >
      {label}{sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
          <Input placeholder="Search customer…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select
            options={[{ value: '', label: 'All cylinder types' }, ...types.map((t) => ({ value: t.id, label: t.name }))]}
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-surface-600 dark:text-surface-300">
            <input type="checkbox" checked={onlyOutstanding} onChange={(e) => setOnlyOutstanding(e.target.checked)} />
            Show only customers with cylinders outstanding
          </label>
        </div>
      </div>

      {!rows.length ? (
        <EmptyState title="No customer balances" description="No customers match the current filters." />
      ) : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <SortTh k="customer" label="Customer" />
                <SortTh k="type" label="Cylinder Type" />
                <SortTh k="qty" label="With Customer" center />
                <SortTh k="cost" label="Empty Cyl Cost" center />
                <SortTh k="days" label="Days Since Last Delivery" center />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.customerId}-${r.cylinderTypeId}-${i}`}>
                  <td className="font-medium text-surface-900 dark:text-white">{r.customerName}</td>
                  <td>{r.cylinderTypeName}</td>
                  <td className="text-center">{r.withCustomerQty}</td>
                  <td className="text-center">
                    {r.emptyCost === null ? (
                      <span
                        className="text-surface-400 cursor-help"
                        title="Set empty cylinder price in Settings → Cylinder Prices"
                      >
                        —
                      </span>
                    ) : (
                      money(r.emptyCost)
                    )}
                  </td>
                  <td className="text-center">{r.days === null ? '—' : `${r.days} days`}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold border-t-2 border-surface-200 dark:border-surface-700">
                <td>Total</td>
                <td></td>
                <td className="text-center">{totalQty}</td>
                <td className="text-center">{money(totalCost)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
