import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import {
  HiOutlineChevronLeft,
  HiOutlineChevronRight,
  HiOutlineLockClosed,
  HiOutlineLockOpen,
  HiOutlinePlus,
  HiOutlineAdjustmentsHorizontal,
  HiOutlineArrowTrendingUp,
  HiOutlineArrowTrendingDown,
  HiOutlineArrowRight,
} from 'react-icons/hi2';
import {
  type InventorySummary,
  type InventoryEvent,
  type CustomerInventoryBalance,
  type InventoryForecast,
  type CylinderType,
  type Vehicle,
  type Driver,
  type PaginationMeta,
  incomingFullsSchema,
  type IncomingFullsInput,
  outgoingEmptiesSchema,
  type OutgoingEmptiesInput,
  type ManualAdjustmentInput,
  localTodayISO,
  localDateISO,
} from '@gaslink/shared';
import { api, apiGet, apiPost, apiPut, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';
import { ReportMismatchModal, MismatchLogSection } from '@/components/inventory/ReportMismatchModal';
import { cn } from '@/lib/cn';

function todayString(): string {
  return localTodayISO();
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return localDateISO(d);
}

interface PendingOrderSummary {
  orderId: string;
  orderNumber: string;
  customerName: string | null;
}

interface PendingCancelledStockLine {
  cseId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  orderNumber: string | null;
  customerName: string | null;
  orderedQty: number;
  deliveredQty: number;
  shortfallQty: number;
  status: 'on_vehicle' | 'pending_return' | string;
}

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
  totalPendingItems: number;
  pendingOrderSummaries: PendingOrderSummary[];
  pendingCancelledStockLines: PendingCancelledStockLine[];
  emptiesTypes: ReconciliationEmptyType[];
  // Open STOCK_MISMATCH pending action exists for this vehicle — the card
  // surfaces an amber badge until the PA is resolved.
  mismatchReported?: boolean;
  // FLOAT-001 (2026-06-17): manifest + float summary for the new
  // "Float Stock Summary" section. Empty arrays when no manifest exists.
  loadManifest?: Array<{
    manifestId: string;
    cylinderTypeId: string;
    cylinderTypeName: string;
    tripNumber: number;
    totalLoaded: number;
    orderedQty: number;
    floatQty: number;
  }>;
  floatSummary?: Array<{
    cylinderTypeId: string;
    cylinderTypeName: string;
    totalLoaded: number;
    orderedQty: number;
    floatQty: number;
    soldFromFloat: number;
    unsoldFloat: number;
  }>;
}

interface ReconciliationConfirmInput {
  physicalStockConfirmed: boolean;
  notes?: string;
  emptiesReturned?: { cylinderTypeId: string; quantity: number }[];
}

// Discriminated union so the toast handler can't accidentally render undefined
// fields from the mismatch branch (which doesn't have the count fields).
type ReconciliationConfirmResult =
  | {
      status: 'reconciled';
      cancelledStockReturned: number;
      undeliveredOrdersCancelled: number;
      emptiesReturned?: number;
    }
  | {
      status: 'mismatch_reported';
      message: string;
    };

// Wire shapes returned by /api/inventory/backdated-adjustments/{pending,history}
interface BackdatedPendingRow {
  orderId: string;
  orderNumber: string;
  customerName: string;
  deliveryDate: string;
  createdAt: string;
  items: { cylinderTypeId: string; cylinderTypeName: string; deliveredQty: number; emptiesCollected: number }[];
}
interface BackdatedHistoryRow {
  eventId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  eventType: string;
  fullsChange: number;
  emptiesChange: number;
  eventDate: string;
  createdAt: string;
  orderId: string | null;
  orderNumber: string | null;
  deliveryDate: string | null;
}

export default function InventoryPage() {
  const queryClient = useQueryClient();
  const [selectedDate, setSelectedDate] = useState(todayString());
  // WI-080 FIX2: allow deep-linking to a tab via ?tab= (e.g. the
  // "AI Demand Forecast" header button → /app/inventory?tab=forecast).
  const initialTab = (typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('tab')
    : null) as ('daily' | 'depot' | 'onboarding' | 'forecast' | 'customer' | 'reconciliation' | 'backdated') | null;
  const validTabs = ['daily', 'depot', 'onboarding', 'forecast', 'customer', 'reconciliation', 'backdated'];
  const [tab, setTab] = useState<'daily' | 'depot' | 'onboarding' | 'forecast' | 'customer' | 'reconciliation' | 'backdated'>(
    initialTab && validTabs.includes(initialTab) ? initialTab : 'daily',
  );
  const [incomingOpen, setIncomingOpen] = useState(false);
  const [outgoingOpen, setOutgoingOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  // WI-4 — Report Mismatch modal is opened per-vehicle from a Vehicle
  // Return card. Null = closed.
  const [mismatchVehicle, setMismatchVehicle] = useState<ReconciliationVehicle | null>(null);

  // Depot History state
  const [depotPage, setDepotPage] = useState(1);
  const [depotEventType, setDepotEventType] = useState<'' | 'incoming_fulls' | 'outgoing_empties'>('');
  const [depotDateFrom, setDepotDateFrom] = useState('');
  const [depotDateTo, setDepotDateTo] = useState('');

  const { data: inventory, isLoading } = useQuery({
    queryKey: ['inventory', selectedDate],
    queryFn: () => apiGet<InventorySummary[]>(`/inventory/summary/${selectedDate}`),
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
    queryFn: () => apiGet<ReconciliationVehicle[]>('/delivery/reconciliation/pending'),
    enabled: tab === 'reconciliation',
  });

  // Backdated Inventory Adjustments — pending list + history. Loaded only
  // when the operator opens the tab to keep landing-page cost flat.
  const { data: backdatedPending, isLoading: backdatedPendingLoading } = useQuery({
    queryKey: ['backdated-adjustments-pending'],
    queryFn: () => apiGet<BackdatedPendingRow[]>('/inventory/backdated-adjustments/pending'),
    enabled: tab === 'backdated',
  });
  const { data: backdatedHistory, isLoading: backdatedHistoryLoading } = useQuery({
    queryKey: ['backdated-adjustments-history'],
    queryFn: () => apiGet<BackdatedHistoryRow[]>('/inventory/backdated-adjustments/history'),
    enabled: tab === 'backdated',
  });
  const [confirmAdjustOrder, setConfirmAdjustOrder] = useState<BackdatedPendingRow | null>(null);
  const applyAdjustment = useMutation({
    mutationFn: (orderId: string) => apiPost(`/orders/${orderId}/apply-inventory-adjustment`),
    onSuccess: (_, orderId) => {
      const ord = backdatedPending?.find((p) => p.orderId === orderId);
      toast.success(`Inventory adjusted${ord ? ` for order ${ord.orderNumber}` : ''}`);
      queryClient.invalidateQueries({ queryKey: ['backdated-adjustments-pending'] });
      queryClient.invalidateQueries({ queryKey: ['backdated-adjustments-history'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      setConfirmAdjustOrder(null);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const reconciliationConfirm = useMutation({
    mutationFn: ({
      vehicleId,
      data,
    }: {
      vehicleId: string;
      data: ReconciliationConfirmInput;
    }) => apiPost<ReconciliationConfirmResult>(`/delivery/reconciliation/confirm/${vehicleId}`, data),
    onSuccess: (result) => {
      if (result.status === 'mismatch_reported') {
        // Stock mismatch path — no inventory was reconciled. The trip stays
        // open until the operations team resolves the pending action.
        toast(
          'Stock mismatch reported. A pending action has been created for investigation. This trip remains open until resolved.',
          { icon: '⚠️', duration: 6000 },
        );
      } else {
        // Happy path — fall back to 0 on each count so the template never
        // renders `undefined` if the server omits an optional field.
        toast.success(
          `Vehicle return complete: ${result.cancelledStockReturned ?? 0} stock returned, ${result.undeliveredOrdersCancelled ?? 0} orders cancelled, ${result.emptiesReturned ?? 0} empties verified`,
        );
      }
      queryClient.invalidateQueries({ queryKey: ['reconciliation-pending'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      // Refresh the pending-actions list — a mismatch creates a new one.
      queryClient.invalidateQueries({ queryKey: ['pending-actions'] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
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

  const { data: drivers } = useQuery({
    queryKey: ['drivers-list'],
    queryFn: () => apiGet<{ drivers: Driver[] }>('/drivers', { status: 'active' }),
    select: (d) => d.drivers,
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

  // The "Undelivered Stock" tab was retired alongside the Vehicle Return
  // redesign — cancelled-stock lines are now shown inline on the matching
  // vehicle's Vehicle Return card, and the single "Confirm" action there
  // returns them to depot as part of closing the trip. Historical undelivered
  // stock is available via the Vehicle Ledger and Inventory Movement reports.
  const tabs = [
    { key: 'daily' as const, label: 'Daily Summary' },
    { key: 'depot' as const, label: 'Depot History' },
    { key: 'onboarding' as const, label: 'Stock at Onboarding' },
    { key: 'forecast' as const, label: 'AI Demand Forecast' },
    { key: 'customer' as const, label: 'Customer Balances' },
    { key: 'reconciliation' as const, label: 'Vehicle Return' },
    { key: 'backdated' as const, label: 'On-Demand Adjustments' },
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
          <DailySummary inventory={inventory} />
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
                  onChange={(e) => { setDepotEventType(e.target.value as '' | 'incoming_fulls' | 'outgoing_empties'); setDepotPage(1); }}
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
        <>
          {reconciliationLoading ? (
            <div className="flex justify-center py-20"><Loader size="lg" /></div>
          ) : !reconciliationVehicles?.length ? (
            <EmptyState
              title="No vehicles pending"
              description="All returned vehicles have been reconciled"
            />
          ) : (
            <div className="grid gap-4">
              {reconciliationVehicles.map((v) => (
                <VehicleReturnCard
                  key={v.vehicleId}
                  vehicle={v}
                  isPending={reconciliationConfirm.isPending}
                  onConfirm={(input) => reconciliationConfirm.mutate({ vehicleId: v.vehicleId, data: input })}
                  onReportMismatch={(target) => setMismatchVehicle(target)}
                />
              ))}
            </div>
          )}
          {/* WI-4 — Mismatch & Correction Log (collapsible) */}
          <MismatchLogSection />
        </>
      )}

      {/* Backdated Adjustments tab */}
      {tab === 'backdated' && (
        <>
          {/* Section 1 — Pending */}
          <div className="card p-4">
            <div className="mb-3">
              <h2 className="text-lg font-semibold text-surface-900 dark:text-white">Pending Inventory Adjustments</h2>
              <p className="text-xs text-surface-500 dark:text-surface-400">
                On-demand orders whose stock has not yet been adjusted. Applying writes events dated <strong>today</strong> — past daily summaries are not changed.
              </p>
            </div>
            {backdatedPendingLoading ? (
              <Loader />
            ) : !backdatedPending?.length ? (
              <EmptyState
                title="No pending adjustments"
                description="All on-demand orders have been adjusted."
              />
            ) : (
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Order #</th>
                      <th>Customer</th>
                      <th>Delivery Date</th>
                      <th>Entered On</th>
                      <th>Items</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backdatedPending.map((row) => {
                      // "2× 19 KG (1 empty), 1× 47.5 KG" — surface
                      // empties only when > 0 so the column stays tidy.
                      const itemSummary = row.items
                        .filter((it) => it.deliveredQty > 0)
                        .map((it) => {
                          const base = `${it.deliveredQty}× ${it.cylinderTypeName}`;
                          return it.emptiesCollected > 0
                            ? `${base} (${it.emptiesCollected} empty)`
                            : base;
                        })
                        .join(', ');
                      return (
                        <tr key={row.orderId}>
                          <td className="font-medium text-surface-900 dark:text-white">{row.orderNumber}</td>
                          <td>{row.customerName}</td>
                          <td>{new Date(row.deliveryDate).toLocaleDateString('en-IN')}</td>
                          <td>{new Date(row.createdAt).toLocaleDateString('en-IN')}</td>
                          <td className="text-xs text-surface-600 dark:text-surface-300">{itemSummary || '—'}</td>
                          <td>
                            <Button size="sm" variant="secondary" onClick={() => setConfirmAdjustOrder(row)}>
                              Apply Adjustment
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Section 2 — History (inline below) */}
          <div className="card p-4 mt-4">
            <div className="mb-3">
              <h2 className="text-lg font-semibold text-surface-900 dark:text-white">Adjustment History</h2>
              <p className="text-xs text-surface-500 dark:text-surface-400">
                Inventory events applied from on-demand orders (most recent first).
              </p>
            </div>
            {backdatedHistoryLoading ? (
              <Loader />
            ) : !backdatedHistory?.length ? (
              <EmptyState
                title="No adjustments applied yet"
                description="History will appear here once you apply an adjustment above."
              />
            ) : (
              <>
                <div className="table-container">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Date Applied</th>
                        <th>Cylinder Type</th>
                        <th>Fulls Adjusted</th>
                        <th>Empties Adjusted</th>
                        <th>Order #</th>
                        <th>Delivery Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backdatedHistory.map((h) => {
                        // Negative fulls land in red so depot debits read
                        // instantly. Empties show as positive with a +
                        // prefix (always a credit).
                        const fullsClass = h.fullsChange < 0
                          ? 'font-medium text-red-600 dark:text-red-400'
                          : h.fullsChange > 0
                            ? 'font-medium'
                            : 'text-surface-400';
                        const emptiesClass = h.emptiesChange > 0
                          ? 'font-medium'
                          : 'text-surface-400';
                        return (
                          <tr key={h.eventId}>
                            <td>{new Date(h.eventDate).toLocaleDateString('en-IN')}</td>
                            <td>{h.cylinderTypeName}</td>
                            <td className={fullsClass}>
                              {h.fullsChange !== 0 ? h.fullsChange : 0}
                            </td>
                            <td className={emptiesClass}>
                              {h.emptiesChange > 0 ? `+${h.emptiesChange}` : 0}
                            </td>
                            <td>{h.orderNumber ?? '—'}</td>
                            <td>{h.deliveryDate ? new Date(h.deliveryDate).toLocaleDateString('en-IN') : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-surface-500 dark:text-surface-400">
                  <strong>Fulls Adjusted</strong> — negative = cylinders debited from depot stock.
                  &nbsp;<strong>Empties Adjusted</strong> — positive = empties credited back to depot.
                </p>
              </>
            )}
          </div>
        </>
      )}

      {/* Confirmation modal for the apply-adjustment action. Built inline
          (not a separate component) because it's small and reads directly
          from the parent's row state + mutation. */}
      {confirmAdjustOrder && (
        <Modal
          open
          onClose={() => setConfirmAdjustOrder(null)}
          title="Apply Inventory Adjustment"
          size="md"
        >
          <div className="space-y-3 text-sm">
            <p>
              This will update today&apos;s stock for order{' '}
              <strong>{confirmAdjustOrder.orderNumber}</strong>:
            </p>
            <ul className="text-xs text-surface-700 dark:text-surface-300 list-disc pl-5 space-y-1">
              {confirmAdjustOrder.items.map((it) => (
                <span key={it.cylinderTypeId} className="contents">
                  {it.deliveredQty > 0 && (
                    <li>Deduct {it.deliveredQty}× {it.cylinderTypeName} fulls</li>
                  )}
                  {it.emptiesCollected > 0 && (
                    <li>Credit {it.emptiesCollected}× {it.cylinderTypeName} empties</li>
                  )}
                </span>
              ))}
            </ul>
            <p className="text-xs text-surface-500 dark:text-surface-400">
              Stock will be updated as of today. Past daily summaries will not be changed.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setConfirmAdjustOrder(null)} disabled={applyAdjustment.isPending}>
                Cancel
              </Button>
              {/* Accent (not bright primary blue) — this is a follow-up
                  commit on an existing order, not a fresh creation. */}
              <Button variant="accent" onClick={() => applyAdjustment.mutate(confirmAdjustOrder.orderId)} loading={applyAdjustment.isPending}>
                Apply Adjustment
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* WI-4 — Report Mismatch Modal */}
      {mismatchVehicle && (
        <ReportMismatchModal
          vehicle={mismatchVehicle}
          cylinderTypes={cylinderTypes ?? []}
          onClose={() => setMismatchVehicle(null)}
        />
      )}

      {/* Incoming Fulls Modal */}
      {incomingOpen && (
        <IncomingFullsModal
          open={incomingOpen}
          onClose={() => setIncomingOpen(false)}
          cylinderTypes={cylinderTypes ?? []}
          vehicles={vehicles?.vehicles ?? []}
          drivers={drivers ?? []}
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
          drivers={drivers ?? []}
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

// ─── Daily Summary — grouped columns + column selector + legend ─────────────
// Six column groups, each tinted with one of three colours (blue/amber/teal)
// used twice. The header band is the 50-stop tint, group title text is 800.
// The column-header row underneath stays white. Cylinder Type and Status are
// always shown — every other column is hideable via the Columns dropdown.
// Hidden-group bands collapse when all their columns are hidden.

type ColGroup = 'CORPORATION' | 'OPENING' | 'ON VEHICLE' | 'AT CUSTOMER' | 'ADJUSTMENTS' | 'CLOSING';
type ColKey =
  | 'corp_in' | 'corp_out'
  | 'open_f' | 'open_e'
  | 'veh_f' | 'veh_e'
  | 'cust_d' | 'cust_c'
  | 'adj_r' | 'adj_m'
  | 'close_f' | 'close_e';

const GROUPS_ORDER: ColGroup[] = ['CORPORATION', 'OPENING', 'ON VEHICLE', 'AT CUSTOMER', 'ADJUSTMENTS', 'CLOSING'];

// 3-colour ramp, each used twice in an alternating pattern down the columns:
//   CORPORATION  blue   |  OPENING amber   |  ON VEHICLE teal
//   AT CUSTOMER  blue   |  ADJUSTMENTS amber  |  CLOSING teal
// One tint per group, used at all three layers (group header band, inner
// column header row, and every data cell in the column). Hex values are the
// saturated 50-stops the user specified — Tailwind's default bg-blue-50 /
// bg-teal-50 are too pale to register against white. Dark mode uses the
// matching X-950/40 fill so the same group tint shows through.
const GROUP_TINT: Record<ColGroup, string> = {
  CORPORATION:   'bg-[#E6F1FB] dark:bg-blue-950/40',
  OPENING:       'bg-[#FAEEDA] dark:bg-amber-950/40',
  'ON VEHICLE':  'bg-[#E1F5EE] dark:bg-teal-950/40',
  'AT CUSTOMER': 'bg-[#E6F1FB] dark:bg-blue-950/40',
  ADJUSTMENTS:   'bg-[#FAEEDA] dark:bg-amber-950/40',
  CLOSING:       'bg-[#E1F5EE] dark:bg-teal-950/40',
};

// Title-text colour per group — paired with GROUP_TINT (blue→blue, amber→
// amber, teal→teal). Used on the group header band and in the Columns
// dropdown section headings.
const GROUP_TITLE: Record<ColGroup, string> = {
  CORPORATION:   'text-blue-800 dark:text-blue-300',
  OPENING:       'text-amber-800 dark:text-amber-300',
  'ON VEHICLE':  'text-teal-800 dark:text-teal-300',
  'AT CUSTOMER': 'text-blue-800 dark:text-blue-300',
  ADJUSTMENTS:   'text-amber-800 dark:text-amber-300',
  CLOSING:       'text-teal-800 dark:text-teal-300',
};

interface ColDef {
  key: ColKey;
  group: ColGroup;
  label: string;
  render: (item: InventorySummary) => ReactNode;
  cellClass?: string | ((item: InventorySummary) => string);
}

const COLS: ColDef[] = [
  { key: 'corp_in', group: 'CORPORATION', label: 'Incoming Fulls', render: (i) => i.incomingFulls > 0 ? `+${i.incomingFulls}` : '0', cellClass: 'text-blue-700 dark:text-blue-300' },
  { key: 'corp_out', group: 'CORPORATION', label: 'Outgoing Empties', render: (i) => i.outgoingEmpties > 0 ? `${i.outgoingEmpties}` : '0', cellClass: 'text-blue-700 dark:text-blue-300' },
  { key: 'open_f', group: 'OPENING', label: 'Fulls', render: (i) => i.openingFulls },
  { key: 'open_e', group: 'OPENING', label: 'Empties', render: (i) => i.openingEmpties },
  { key: 'veh_f', group: 'ON VEHICLE', label: 'Fulls', render: (i) => i.inFlightFulls ?? 0, cellClass: 'text-amber-700 dark:text-amber-300 font-medium' },
  { key: 'veh_e', group: 'ON VEHICLE', label: 'Empties', render: (i) => i.emptiesOnVehicle ?? 0, cellClass: 'text-amber-700 dark:text-amber-300' },
  { key: 'cust_d', group: 'AT CUSTOMER', label: 'Delivered Fulls', render: (i) => i.deliveredQty > 0 ? `${i.deliveredQty}` : '0', cellClass: 'text-teal-700 dark:text-teal-300' },
  { key: 'cust_c', group: 'AT CUSTOMER', label: 'Collected Empties', render: (i) => i.collectedEmpties, cellClass: 'text-teal-700 dark:text-teal-300' },
  { key: 'adj_r', group: 'ADJUSTMENTS', label: 'Returned', render: (i) => i.cancelledStockQty, cellClass: 'text-flame-600 dark:text-flame-400' },
  {
    key: 'adj_m', group: 'ADJUSTMENTS', label: 'Manual',
    render: (i) => { const n = i.manualAdjustment; return n > 0 ? `+${n}` : n < 0 ? `${n}` : '0'; },
    cellClass: (i) => (i.manualAdjustment ?? 0) === 0 ? 'text-surface-400 text-xs' : 'font-medium',
  },
  { key: 'close_f', group: 'CLOSING', label: 'Fulls', render: (i) => i.closingFulls, cellClass: 'font-semibold' },
  { key: 'close_e', group: 'CLOSING', label: 'Empties', render: (i) => i.closingEmpties, cellClass: 'font-semibold' },
];

const COL_PREF_KEY = 'gaslink_inventory_col_prefs';

function loadHidden(): Set<ColKey> {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(COL_PREF_KEY) : null;
    if (raw) return new Set(JSON.parse(raw) as ColKey[]);
  } catch { /* ignore */ }
  return new Set();
}
function saveHidden(h: Set<ColKey>) {
  try { localStorage.setItem(COL_PREF_KEY, JSON.stringify([...h])); } catch { /* ignore */ }
}

function DailySummary({ inventory }: { inventory: InventorySummary[] }) {
  const [hidden, setHidden] = useState<Set<ColKey>>(() => loadHidden());
  const [pickerOpen, setPickerOpen] = useState(false);

  const toggle = (k: ColKey) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      saveHidden(next);
      return next;
    });
  };

  const visibleCols = COLS.filter((c) => !hidden.has(c.key));
  const visibleGroups = GROUPS_ORDER
    .map((g) => ({ name: g, cols: visibleCols.filter((c) => c.group === g) }))
    .filter((g) => g.cols.length > 0);

  return (
    <div className="space-y-4">
      {/* Columns selector */}
      <div className="flex items-center justify-end relative">
        <Button variant="secondary" size="sm" onClick={() => setPickerOpen((v) => !v)}>
          Columns
        </Button>
        {pickerOpen && (
          <div className="absolute right-0 top-9 z-20 w-64 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg shadow-lg p-3 space-y-2 text-sm">
            <div className="text-xs text-surface-500 dark:text-surface-400 mb-1">
              Show / hide columns (Cylinder Type and Status are always shown)
            </div>
            {GROUPS_ORDER.map((g) => (
              <div key={g}>
                <div className={cn('text-[11px] font-semibold uppercase tracking-wide', GROUP_TITLE[g])}>{g}</div>
                {COLS.filter((c) => c.group === g).map((c) => (
                  <label key={c.key} className="flex items-center gap-2 py-0.5 cursor-pointer hover:bg-surface-50 dark:hover:bg-surface-700/40 px-1 rounded">
                    <input
                      type="checkbox"
                      checked={!hidden.has(c.key)}
                      onChange={() => toggle(c.key)}
                      className="rounded"
                    />
                    <span className="text-surface-800 dark:text-surface-200">{c.label}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="table-container">
        <table className="table">
          <thead>
            <tr>
              <th rowSpan={2} className="align-bottom">Cylinder Type</th>
              {visibleGroups.map((g) => (
                <th key={g.name} colSpan={g.cols.length} className={cn('text-center text-[11px] uppercase tracking-wide', GROUP_TINT[g.name], GROUP_TITLE[g.name])}>
                  {g.name}
                </th>
              ))}
              <th rowSpan={2} className={cn('align-bottom', GROUP_TINT.CLOSING)}>Status</th>
            </tr>
            <tr>
              {visibleGroups.flatMap((g) => g.cols.map((c) => (
                <th key={c.key} className={cn('text-center font-medium text-surface-700 dark:text-surface-300', GROUP_TINT[c.group])}>
                  {c.label}
                </th>
              )))}
            </tr>
          </thead>
          <tbody>
            {inventory.map((item) => {
              const isWarning = item.thresholdWarning !== null && item.closingFulls <= item.thresholdWarning;
              const isCritical = item.thresholdCritical !== null && item.closingFulls <= item.thresholdCritical;
              return (
                <tr key={item.cylinderTypeId}>
                  <td className="font-medium text-surface-900 dark:text-white">{item.cylinderTypeName}</td>
                  {visibleGroups.flatMap((g) => g.cols.map((c) => {
                    const cls = typeof c.cellClass === 'function' ? c.cellClass(item) : c.cellClass;
                    // Critical-low override for Closing Fulls cell
                    const extra = c.key === 'close_f' && isCritical ? 'text-red-500' : '';
                    return (
                      <td key={c.key} className={cn('text-center', GROUP_TINT[c.group], cls, extra)}>
                        {c.render(item)}
                      </td>
                    );
                  }))}
                  <td className={cn(GROUP_TINT.CLOSING)}>
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

      {/* Legend — always visible, two parts */}
      <div className="space-y-3 pt-2">
        <div className="space-y-1 text-[12px] text-surface-600 dark:text-surface-400">
          <p><span className="font-semibold text-surface-800 dark:text-surface-200">Corporation</span> — Cylinders received from your corporation (Incoming Fulls) or empty cylinders sent back (Outgoing Empties). These are your supply movements for the day.</p>
          <p><span className="font-semibold text-surface-800 dark:text-surface-200">Opening</span> — Your depot stock at the start of the day, carried forward from yesterday&apos;s closing.</p>
          <p><span className="font-semibold text-surface-800 dark:text-surface-200">On Vehicle</span> — Cylinders and empties currently with drivers. Fulls on Vehicle drops to zero when all vehicles return. Empties on Vehicle drops to zero when all vehicles reconcile at depot.</p>
          <p><span className="font-semibold text-surface-800 dark:text-surface-200">At Customer</span> — Informational only, does not affect depot stock. Delivered Fulls = fulls confirmed received by customers. Collected Empties = empties the driver recorded collecting during the trip.</p>
          <p><span className="font-semibold text-surface-800 dark:text-surface-200">Adjustments</span> — Returned = cylinders brought back from cancelled orders. Manual = stock corrections entered by the inventory team.</p>
          <p><span className="font-semibold text-surface-800 dark:text-surface-200">Closing</span> — Your depot stock position for the day, updated in real time.</p>
        </div>
        <div className="border-l-4 border-blue-400 bg-blue-50 dark:bg-blue-950/40 px-4 py-3 rounded-r text-[13px] text-surface-800 dark:text-surface-200">
          <p className="font-semibold mb-1 text-blue-800 dark:text-blue-300">Example — 19 KG cylinders on a typical day:</p>
          <p>
            Opening Fulls = 200. You receive a corporation load of 50 (Incoming Fulls = +50, Closing Fulls = 250). You dispatch Driver A with 30 cylinders (Fulls on Vehicle = 30, Closing Fulls = 220). Driver A delivers 28 to customers (Delivered Fulls = 28, Fulls on Vehicle drops to 2). Driver A collects 20 empties from customers on the trip (Collected Empties = 20 — informational, not in your depot yet). Driver A returns; you verify 19 empties came back (Closing Empties rises by 19, Empties on Vehicle drops to 1 — that 1 is unaccounted). You also dispatch Driver B with 10 cylinders during the day (Fulls on Vehicle = 10 for Driver B&apos;s trip until they return). End of day once all drivers back: Fulls on Vehicle = 0, Empties on Vehicle = 0 or gap only.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Vehicle Return card ─────────────────────────────────────────────────────
// One card per vehicle waiting to be reconciled. Two inline sections:
//   A. Cancelled-stock lines (informational — confirm action returns them).
//   B. Empties verification — one editable input per active cylinder type,
//      pre-filled with the delivery-time collected amount. The supervisor
//      adjusts to the physically-verified count if different. A single
//      "Confirm & Reconcile" button writes everything atomically; the gap
//      between collected and verified surfaces on the Vehicle Ledger.
//
// Empties are always sent (even when unchanged from pre-fill) so the gap
// column is computed correctly for every reconciliation.
function VehicleReturnCard({
  vehicle,
  isPending,
  onConfirm,
  onReportMismatch,
}: {
  vehicle: ReconciliationVehicle;
  isPending: boolean;
  onConfirm: (input: ReconciliationConfirmInput) => void;
  onReportMismatch: (v: ReconciliationVehicle) => void;
}) {
  const [empties, setEmpties] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      (vehicle.emptiesTypes ?? []).map((t) => [t.cylinderTypeId, t.collectedQty]),
    ),
  );
  const setQty = (id: string, value: string) => {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    setEmpties((prev) => ({ ...prev, [id]: n }));
  };
  const submit = () => {
    const pendingDeliveries = vehicle.pendingOrderSummaries ?? [];
    if (pendingDeliveries.length > 0) {
      const names = pendingDeliveries
        .map((o) => `${o.orderNumber} (${o.customerName ?? 'Unknown'})`)
        .join('\n');
      const ok = confirm(
        `Warning: The following orders are still pending delivery and will be force-cancelled:\n\n${names}\n\nProceed?`,
      );
      if (!ok) return;
    }
    onConfirm({
      physicalStockConfirmed: true,
      notes: 'Physical stock matches system',
      emptiesReturned: (vehicle.emptiesTypes ?? []).map((t) => ({
        cylinderTypeId: t.cylinderTypeId,
        quantity: empties[t.cylinderTypeId] ?? 0,
      })),
    });
  };
  const lines = vehicle.pendingCancelledStockLines ?? [];
  const emptiesTypes = vehicle.emptiesTypes ?? [];

  return (
    <div className="bg-white dark:bg-surface-800 rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold">{vehicle.vehicleNumber}</h3>
          {vehicle.mismatchReported && (
            <p className="mt-1 inline-flex items-center gap-1 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 text-xs px-2 py-0.5">
              <span aria-hidden>⚠️</span>
              Mismatch reported — check Pending Actions
            </p>
          )}
          <p className="text-sm text-surface-500 mt-1">
            {lines.length} cancelled-stock line{lines.length === 1 ? '' : 's'}
            {vehicle.pendingUndeliveredOrders > 0
              ? ` · ${vehicle.pendingUndeliveredOrders} undelivered order${vehicle.pendingUndeliveredOrders === 1 ? '' : 's'} will be force-cancelled`
              : ''}
          </p>
        </div>
        <Badge variant="warning">Pending Verification</Badge>
      </div>

      {/* Section A — cancelled-stock lines (informational) */}
      {lines.length > 0 && (
        <div className="mb-5">
          <h4 className="text-sm font-medium text-surface-800 dark:text-surface-200 mb-2">
            Cylinders returning to depot
          </h4>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Cylinder Type</th>
                  <th className="text-center">Ordered</th>
                  <th className="text-center">Delivered</th>
                  <th className="text-center">Shortfall</th>
                  <th>Order</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.cseId}>
                    <td className="font-medium">{l.cylinderTypeName}</td>
                    <td className="text-center">{l.orderedQty}</td>
                    <td className="text-center">{l.deliveredQty}</td>
                    <td className="text-center text-flame-600 dark:text-flame-400">{l.shortfallQty}</td>
                    <td className="text-xs">
                      {l.orderNumber}
                      {l.customerName ? <span className="text-surface-500"> · {l.customerName}</span> : null}
                    </td>
                    <td>
                      <Badge variant={l.status === 'on_vehicle' ? 'warning' : 'neutral'}>
                        {String(l.status).replace(/_/g, ' ')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* FLOAT-001: Section A2 — float stock summary (read-only). Shows the
          admin what's about to be credited back when they confirm reconciliation. */}
      {(vehicle.floatSummary ?? []).length > 0 && (
        <div className="mb-5">
          <h4 className="text-sm font-medium text-surface-800 dark:text-surface-200 mb-1">
            Spare Stock Summary
          </h4>
          <p className="text-xs text-surface-500 mb-2">
            Unsold spare stock will be automatically returned to depot inventory on vehicle return.
          </p>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Cylinder Type</th>
                  <th className="text-center">Loaded</th>
                  <th className="text-center">Booked</th>
                  <th className="text-center">Spare</th>
                  <th className="text-center">Walk-in Sales</th>
                  <th className="text-center">Returning to Depot</th>
                </tr>
              </thead>
              <tbody>
                {(vehicle.floatSummary ?? []).map((f) => (
                  <tr key={f.cylinderTypeId}>
                    <td className="font-medium">{f.cylinderTypeName}</td>
                    <td className="text-center">{f.totalLoaded}</td>
                    <td className="text-center">{f.orderedQty}</td>
                    <td className="text-center">{f.floatQty}</td>
                    <td className="text-center">{f.soldFromFloat}</td>
                    <td className="text-center text-flame-600 dark:text-flame-400">{f.unsoldFloat}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Section B — empties verification */}
      {emptiesTypes.length > 0 && (
        <div className="mb-5">
          <h4 className="text-sm font-medium text-surface-800 dark:text-surface-200">
            Empties returning to depot
          </h4>
          <p className="text-xs text-surface-500 mb-2">
            Pre-filled with the empties collected at customer stops during this trip.
            Adjust the number if the physical count differs.
          </p>
          <div className="grid gap-2 max-w-md">
            {emptiesTypes.map((t) => (
              <div key={t.cylinderTypeId} className="flex items-center justify-between gap-3">
                <label className="text-sm text-surface-700 dark:text-surface-300">
                  {t.typeName}
                  <span className="ml-1 text-xs text-surface-400">(collected {t.collectedQty})</span>
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
        </div>
      )}

      <div className="flex gap-3">
        <Button onClick={submit} disabled={isPending}>
          Confirm &amp; Reconcile
        </Button>
        {/* WI-4: Report Mismatch now opens a structured 3-step modal that
            posts to /inventory/mismatch-reports (records + PA + inventory
            event in one transaction). The legacy generic-PA endpoint is
            no longer used by this button. */}
        <Button
          variant="secondary"
          onClick={() => onReportMismatch(vehicle)}
          disabled={isPending}
        >
          Report Mismatch
        </Button>
      </div>
    </div>
  );
}

// ─── Adjust Stock Modal (WI-3 — Fulls/Empties toggle + History tab) ─────────

interface ManualAdjustmentHistoryRow {
  eventId: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  bucket: 'fulls' | 'empties';
  quantity: number;
  reason: string;
  eventDate: string;
  createdAt: string;
  enteredByUserId: string;
  enteredByName: string;
}

interface AdjustmentHistoryResponse {
  data: ManualAdjustmentHistoryRow[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

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
  const [tab, setTab] = useState<'new' | 'history'>('new');
  // ── New Adjustment tab state ──
  const [bucket, setBucket] = useState<'fulls' | 'empties'>('fulls');
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
    onSubmit({
      cylinderTypeId,
      bucket,
      adjustmentType: qty > 0 ? 'add' : 'subtract',
      quantity: Math.abs(qty),
      reason: reason.trim(),
      adjustmentDate: date,
    });
  };

  // ── History tab state ──
  const [histPage, setHistPage] = useState(1);
  const [histBucket, setHistBucket] = useState<'all' | 'fulls' | 'empties'>('all');
  const [histCylinderTypeId, setHistCylinderTypeId] = useState('');
  const [histFrom, setHistFrom] = useState('');
  const [histTo, setHistTo] = useState('');
  const PAGE_SIZE = 50;

  const historyQuery = useQuery<AdjustmentHistoryResponse>({
    queryKey: ['manual-adjustments', { histPage, histBucket, histCylinderTypeId, histFrom, histTo }],
    queryFn: () => {
      const q = new URLSearchParams();
      q.set('page', String(histPage));
      q.set('pageSize', String(PAGE_SIZE));
      if (histBucket !== 'all') q.set('bucket', histBucket);
      if (histCylinderTypeId) q.set('cylinderTypeId', histCylinderTypeId);
      if (histFrom) q.set('dateFrom', histFrom);
      if (histTo) q.set('dateTo', histTo);
      return apiGet<AdjustmentHistoryResponse>(`/inventory/manual-adjustments?${q.toString()}`);
    },
    enabled: open && tab === 'history',
  });

  const downloadCsv = async () => {
    // Use the raw `api` axios instance (not apiGet) so we get the Blob
    // through the auth+distributor interceptors without the envelope
    // unwrap. Matches the pattern used by PDF downloads elsewhere
    // (BillingPaymentsPage, OrdersPage, CustomersPage).
    const params: Record<string, string> = { format: 'csv' };
    if (histBucket !== 'all') params.bucket = histBucket;
    if (histCylinderTypeId) params.cylinderTypeId = histCylinderTypeId;
    if (histFrom) params.dateFrom = histFrom;
    if (histTo) params.dateTo = histTo;
    try {
      const res = await api.get('/inventory/manual-adjustments', { params, responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'manual-adjustments.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Adjust Stock" size="xl">
      {/* Fix 2 (2026-05-29): widen + raise floor so the history table breathes
          (min 720×560). The xl Modal size gives ~896px max-width; min-w/h on
          this inner wrapper guarantees the floor when the form tab is short. */}
      <div className="min-w-[720px] min-h-[560px]">
      {/* Tab strip */}
      <div className="flex border-b border-surface-200 dark:border-surface-700 mb-4">
        <button
          type="button"
          onClick={() => setTab('new')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'new'
              ? 'border-brand-500 text-brand-600 dark:text-brand-400'
              : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300'
          }`}
        >
          New Adjustment
        </button>
        <button
          type="button"
          onClick={() => setTab('history')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'history'
              ? 'border-brand-500 text-brand-600 dark:text-brand-400'
              : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300'
          }`}
        >
          Adjustment History
        </button>
      </div>

      {tab === 'new' ? (
        <div className="space-y-4">
          {/* Fulls / Empties toggle */}
          <div>
            <label className="label">Bucket</label>
            <div className="inline-flex rounded-md border border-surface-300 dark:border-surface-700 overflow-hidden">
              <button
                type="button"
                onClick={() => setBucket('fulls')}
                className={`px-4 py-1.5 text-sm font-medium ${
                  bucket === 'fulls'
                    ? 'bg-brand-500 text-white'
                    : 'bg-white dark:bg-surface-800 text-surface-700 dark:text-surface-300'
                }`}
              >
                Fulls
              </button>
              <button
                type="button"
                onClick={() => setBucket('empties')}
                className={`px-4 py-1.5 text-sm font-medium ${
                  bucket === 'empties'
                    ? 'bg-brand-500 text-white'
                    : 'bg-white dark:bg-surface-800 text-surface-700 dark:text-surface-300'
                }`}
              >
                Empties
              </button>
            </div>
          </div>
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
            label="Reason / Notes"
            placeholder="Reason for adjustment (required)"
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
      ) : (
        <div className="space-y-4">
          {/* History filters */}
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Bucket"
              options={[
                { value: 'all', label: 'All' },
                { value: 'fulls', label: 'Fulls' },
                { value: 'empties', label: 'Empties' },
              ]}
              value={histBucket}
              onChange={(e) => { setHistPage(1); setHistBucket(e.target.value as 'all' | 'fulls' | 'empties'); }}
            />
            <Select
              label="Cylinder Type"
              options={[{ value: '', label: 'All' }, ...cylinderOptions]}
              value={histCylinderTypeId}
              onChange={(e) => { setHistPage(1); setHistCylinderTypeId(e.target.value); }}
            />
            <Input
              label="From"
              type="date"
              value={histFrom}
              onChange={(e) => { setHistPage(1); setHistFrom(e.target.value); }}
            />
            <Input
              label="To"
              type="date"
              value={histTo}
              onChange={(e) => { setHistPage(1); setHistTo(e.target.value); }}
            />
          </div>

          {/* Rows. Fix 2: tbody scrolls vertically so many rows don't push the
              pagination off-screen; whitespace-nowrap on cells stops column
              truncation. Header stays visible while body scrolls. */}
          <div className="border border-surface-200 dark:border-surface-700 rounded-md overflow-hidden">
            <table className="w-full text-sm table-auto">
              <thead className="bg-surface-50 dark:bg-surface-800/50 text-xs uppercase text-surface-500">
                <tr>
                  <th className="px-3 py-2 text-left whitespace-nowrap">Date</th>
                  <th className="px-3 py-2 text-left whitespace-nowrap">Cylinder</th>
                  <th className="px-3 py-2 text-left whitespace-nowrap">Bucket</th>
                  <th className="px-3 py-2 text-right whitespace-nowrap">Qty</th>
                  <th className="px-3 py-2 text-left whitespace-nowrap">Reason</th>
                  <th className="px-3 py-2 text-left whitespace-nowrap">Entered By</th>
                </tr>
              </thead>
            </table>
            <div className="max-h-[360px] overflow-y-auto">
              <table className="w-full text-sm table-auto">
                <tbody>
                  {historyQuery.isLoading ? (
                    <tr><td colSpan={6} className="px-3 py-4 text-center text-surface-400">Loading…</td></tr>
                  ) : (historyQuery.data?.data.length ?? 0) === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-4 text-center text-surface-400">No adjustments match these filters.</td></tr>
                  ) : (
                    historyQuery.data!.data.map((r) => (
                      <tr key={r.eventId} className="border-t border-surface-200 dark:border-surface-700">
                        <td className="px-3 py-2 text-surface-600 dark:text-surface-400 whitespace-nowrap">{new Date(r.eventDate).toLocaleDateString('en-IN')}</td>
                        <td className="px-3 py-2 font-medium whitespace-nowrap">{r.cylinderTypeName}</td>
                        <td className="px-3 py-2 capitalize whitespace-nowrap">{r.bucket}</td>
                        <td className={`px-3 py-2 text-right font-mono whitespace-nowrap ${r.quantity >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                          {r.quantity >= 0 ? `+${r.quantity}` : r.quantity}
                        </td>
                        <td className="px-3 py-2 text-surface-700 dark:text-surface-300 whitespace-nowrap">{r.reason}</td>
                        <td className="px-3 py-2 text-surface-500 whitespace-nowrap">{r.enteredByName}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination + CSV */}
          <div className="flex items-center justify-between gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={downloadCsv} disabled={(historyQuery.data?.data.length ?? 0) === 0}>
              Download CSV
            </Button>
            <div className="flex items-center gap-2 text-sm text-surface-500">
              <Button type="button" variant="secondary" disabled={histPage <= 1} onClick={() => setHistPage((p) => Math.max(1, p - 1))}>
                Prev
              </Button>
              <span>
                Page {historyQuery.data?.meta.page ?? 1} / {historyQuery.data?.meta.totalPages ?? 1}
              </span>
              <Button type="button" variant="secondary" disabled={(historyQuery.data?.meta.totalPages ?? 1) <= histPage} onClick={() => setHistPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
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
  drivers,
  date,
}: {
  open: boolean;
  onClose: () => void;
  cylinderTypes: CylinderType[];
  vehicles: Vehicle[];
  drivers: Driver[];
  date: string;
}) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, control, setValue, formState: { errors } } = useForm<IncomingFullsInput>({
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
  const driverOptions = drivers.map((d) => ({ value: d.driverName, label: d.driverName }));

  // Vehicle and Driver are dropdowns — no free-text duplicates. Picking a
  // vehicle copies its plate to the persisted `vehicleNumber` field and
  // auto-selects the currently-assigned driver if one exists in the active
  // drivers list. Both can be cleared or changed independently.
  // useWatch (not watch()) — react-hook-form's watch() returns a non-stable
  // subscription callable that React Compiler can't safely memoize
  // (rule: react-hooks/incompatible-library).
  const selectedVehicleId = useWatch({ control, name: 'vehicleId' });
  useEffect(() => {
    if (!selectedVehicleId) {
      setValue('vehicleNumber', '', { shouldDirty: true });
      return;
    }
    const v = vehicles.find((x) => x.vehicleId === selectedVehicleId);
    if (!v) return;
    setValue('vehicleNumber', v.vehicleNumber ?? '', { shouldDirty: true });
    // Auto-select driver only when the vehicle's last assigned driver matches
    // an active driver row. Otherwise leave driver dropdown alone — user picks.
    if (v.currentDriverName) {
      const match = drivers.find((d) => d.driverName === v.currentDriverName);
      if (match) setValue('driverName', match.driverName, { shouldDirty: true });
    }
  }, [selectedVehicleId, vehicles, drivers, setValue]);

  return (
    <Modal open={open} onClose={onClose} title="Record Incoming Fulls">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Select label="Cylinder Type" options={cylinderOptions} placeholder="Select type" required error={errors.cylinderTypeId?.message} {...register('cylinderTypeId')} />
        <Input label="Quantity" type="number" min={1} required error={errors.quantity?.message} {...register('quantity', { valueAsNumber: true })} />
        {/* WI-1.4: Document* labels renamed to Supply* in the UI; backend
            column names (document_type / document_number / document_date)
            stay the same to preserve historical rows. */}
        <Input label="Supply Type" placeholder="e.g. Delivery Challan" required error={errors.documentType?.message} {...register('documentType')} />
        <Input label="Supply Reference No." required error={errors.documentNumber?.message} {...register('documentNumber')} />
        <Input label="Supply Date" type="date" required error={errors.documentDate?.message} {...register('documentDate')} />
        <Select label="Vehicle" options={vehicleOptions} placeholder="Select vehicle (optional)" {...register('vehicleId')} />
        <Select label="Driver" options={driverOptions} placeholder="Select driver (optional)" {...register('driverName')} />
        <Input
          label="Amount (₹)"
          type="number"
          min={0}
          step="0.01"
          placeholder="Total invoice value from the corporation (optional)"
          error={errors.amount?.message}
          {...register('amount', { setValueAs: (v) => v === '' || v === null || v === undefined ? undefined : Number(v) })}
        />
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
  drivers,
  date,
}: {
  open: boolean;
  onClose: () => void;
  cylinderTypes: CylinderType[];
  vehicles: Vehicle[];
  drivers: Driver[];
  date: string;
}) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, control, setValue, formState: { errors } } = useForm<OutgoingEmptiesInput>({
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
  const driverOptions = drivers.map((d) => ({ value: d.driverName, label: d.driverName }));

  // Same shape as the Incoming Fulls modal: Vehicle + Driver are dropdowns,
  // no free-text duplicates. Vehicle selection sets the persisted plate and
  // auto-selects the vehicle's current driver if they're in the active list.
  // useWatch (not watch()) — react-hook-form's watch() returns a non-stable
  // subscription callable that React Compiler can't safely memoize
  // (rule: react-hooks/incompatible-library).
  const selectedVehicleId = useWatch({ control, name: 'vehicleId' });
  useEffect(() => {
    if (!selectedVehicleId) {
      setValue('vehicleNumber', '', { shouldDirty: true });
      return;
    }
    const v = vehicles.find((x) => x.vehicleId === selectedVehicleId);
    if (!v) return;
    setValue('vehicleNumber', v.vehicleNumber ?? '', { shouldDirty: true });
    if (v.currentDriverName) {
      const match = drivers.find((d) => d.driverName === v.currentDriverName);
      if (match) setValue('driverName', match.driverName, { shouldDirty: true });
    }
  }, [selectedVehicleId, vehicles, drivers, setValue]);

  return (
    <Modal open={open} onClose={onClose} title="Record Outgoing Empties">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Select label="Cylinder Type" options={cylinderOptions} placeholder="Select type" required error={errors.cylinderTypeId?.message} {...register('cylinderTypeId')} />
        <Input label="Quantity" type="number" min={1} required error={errors.quantity?.message} {...register('quantity', { valueAsNumber: true })} />
        {/* WI-1.4: Document* labels renamed to Challan* in the UI; backend
            column names (document_type / document_number / document_date)
            stay the same to preserve historical rows. */}
        <Input label="Challan Type" placeholder="e.g. Return Challan" required error={errors.documentType?.message} {...register('documentType')} />
        <Input label="Challan No." required error={errors.documentNumber?.message} {...register('documentNumber')} />
        <Input label="Challan Date" type="date" required error={errors.documentDate?.message} {...register('documentDate')} />
        <Select label="Vehicle" options={vehicleOptions} placeholder="Select vehicle (optional)" {...register('vehicleId')} />
        <Select label="Driver" options={driverOptions} placeholder="Select driver (optional)" {...register('driverName')} />
        <Input label="Authorization Ref." placeholder="Reference / approval no. (optional)" error={errors.authorizationRef?.message} {...register('authorizationRef')} />
        <Input
          label="Amount (₹)"
          type="number"
          min={0}
          step="0.01"
          placeholder="Value of empties returned (optional)"
          error={errors.amount?.message}
          {...register('amount', { setValueAs: (v) => v === '' || v === null || v === undefined ? undefined : Number(v) })}
        />
        <Select
          label="Condition"
          options={[
            { value: 'good', label: 'Good' },
            { value: 'defective', label: 'Defective' },
          ]}
          placeholder="Select condition (optional)"
          error={errors.condition?.message}
          {...register('condition')}
        />
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

function SortTh({ k, label, center, sortKey, sortDir, onSort }: {
  k: SortKey;
  label: string;
  center?: boolean;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
}) {
  return (
    <th
      className={cn('cursor-pointer select-none hover:text-brand-600', center && 'text-center')}
      onClick={() => onSort(k)}
    >
      {label}{sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );
}

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

  // Capture "now" once via a lazy initializer so render stays pure (no impure
  // Date.now() call during render). Day-granularity display tolerates this.
  const [now] = useState(() => Date.now());
  const daysSince = (d?: string | null): number | null =>
    d ? Math.floor((now - new Date(d).getTime()) / 86400000) : null;
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
                <SortTh k="customer" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortTh k="type" label="Cylinder Type" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortTh k="qty" label="With Customer" center sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortTh k="cost" label="Empty Cyl Cost" center sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortTh k="days" label="Days Since Last Delivery" center sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
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
