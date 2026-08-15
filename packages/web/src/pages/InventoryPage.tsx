import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch, useFieldArray } from 'react-hook-form';
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
  HiOutlineTruck,
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
  emptiesReturnSchema,
  type EmptiesReturnInput,
  localTodayISO,
  localDateISO,
  formatDisplayDate,
  type DefectiveEligibleInvoice,
  type DefectiveReturn,
} from '@gaslink/shared';
import { api, apiGet, apiPost, apiPut, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState, CustomerSearchInput } from '@/components/ui';
import { ReportMismatchModal, MismatchLogSection } from '@/components/inventory/ReportMismatchModal';
import { cn } from '@/lib/cn';
// Mini-Operator (2026-07-16): role-aware branches — rename Godown/Purchase,
// hide fleet-adjacent tabs and buttons.
import { useAuthStore, selectRole } from '@/stores/authStore';
// "Set Opening Stock" modal reused from the Settings → Onboarding checklist.
// Mini-op tenants don't have the Settings → Onboarding tab, so the Godown →
// Stock at Onboarding tab surfaces the same modal via a button.
import { OpeningStockModal } from '@/components/OnboardingTab';

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

// 2026-08-05 — Depot History Amount column formatter. Accepts both
// string and number (Prisma Decimal wire shape varies by adapter).
// Returns '-' for null / empty / non-numeric.
function formatDepotAmount(raw: string | number | null | undefined): string {
  if (raw == null || raw === '') return '-';
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return '-';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(n);
}

export default function InventoryPage() {
  const queryClient = useQueryClient();
  // Mini-Operator (2026-07-16): drives the header rename (Godown), tab
  // filter (hide Depot History / AI Forecast / Vehicle Return), buttons
  // filter (hide Incoming Fulls / Outgoing Empties — mini-op uses the
  // Purchases page instead), and column-group label ("Corporation" →
  // "Purchase").
  const role = useAuthStore(selectRole);
  const isMiniOperator = role === 'mini_operator_admin';
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
  // Item 7 (2026-07-09) — lightweight customer empties return.
  const [emptiesReturnOpen, setEmptiesReturnOpen] = useState(false);
  // F1 (2026-08-06) — customer defective full pickup + inline CN raise.
  const [defectiveReturnOpen, setDefectiveReturnOpen] = useState(false);
  // 2026-07-19: Vehicles-in-transit quick view (button beside Empties Return).
  const [vehiclesInTransitOpen, setVehiclesInTransitOpen] = useState(false);
  // Mini-Operator (2026-07-16): opening-stock modal state, opened from the
  // Stock at Onboarding tab button. Available to all roles that reach the
  // Godown page — the backend still gates the write.
  const [openingStockOpen, setOpeningStockOpen] = useState(false);
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
  const tabs = isMiniOperator
    // Mini-Operator: no fleet ⇒ no Vehicle Return; no AI Forecast entry (the
    // top-bar shortcut is hidden too); Depot History is too much for a
    // single-user shop; backdated stock adjustments belong to a Distributor
    // admin flow. Leave Daily Summary + Stock at Onboarding + Customer
    // Balances — the only three that make sense for a mini-op godown.
    ? [
        { key: 'daily' as const, label: 'Daily Summary' },
        { key: 'onboarding' as const, label: 'Stock at Onboarding' },
        { key: 'customer' as const, label: 'Customer Balances' },
      ]
    : [
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
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">
            {isMiniOperator ? 'Stock' : 'Godown'}
          </h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
            {isMiniOperator ? 'Fulls and empties in your depot' : 'Track cylinder stock levels'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'daily' && !isLocked && (
            <>
              {/* Mini-Operator: hide Incoming Fulls + Outgoing Empties — those
                  are stock movements against the corporation supply pipeline
                  for full distributors. Mini-op logs the same events via the
                  Purchases page (source distributor + line items). Adjust
                  Stock and Empties Return stay — they're generic corrections. */}
              {!isMiniOperator && (
                <>
                  <Button variant="secondary" size="sm" onClick={() => setIncomingOpen(true)}>
                    <HiOutlinePlus className="h-4 w-4" />Incoming Fulls
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setOutgoingOpen(true)}>
                    <HiOutlinePlus className="h-4 w-4" />Outgoing Empties
                  </Button>
                </>
              )}
              <Button variant="secondary" size="sm" onClick={() => setAdjustOpen(true)}>
                <HiOutlineAdjustmentsHorizontal className="h-4 w-4" />Adjust Stock
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setEmptiesReturnOpen(true)}>
                <HiOutlinePlus className="h-4 w-4" />Empties Return
              </Button>
              {/* F1 (2026-08-06) — Defective Return button + modal, sibling
                  to Empties Return. Suneel spec: "should be a button
                  similar to empties return in daily summary". Modal
                  captures + fires CN inline; History / Send to Corp are
                  on the dedicated /app/defective-returns page (accessible
                  via the "View history" link inside the modal, or by
                  direct URL). Sidebar entry was removed by Suneel — the
                  pending-count chip lives on this button instead. */}
              <DefectiveReturnButton onClick={() => setDefectiveReturnOpen(true)} />
              {/* 2026-07-19 — Vehicles: quick view of DVAs currently on
                  the road + those reconciled today. Read-only. */}
              <Button variant="secondary" size="sm" onClick={() => setVehiclesInTransitOpen(true)}>
                <HiOutlineTruck className="h-4 w-4" />Vehicles
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
                      {/* F1-FIX-18 (2026-08-06) — piggybacked defective count.
                          Populated only on outgoing rows whose challan matches
                          a DefectiveReturnBatch. Blank on incoming rows and on
                          outgoing rows with no defective piggyback. */}
                      <th className="text-right">Defective</th>
                      <th className="text-right">Amount</th>
                      <th>Vehicle No</th>
                      <th>Driver</th>
                      <th>Doc Type</th>
                      <th>Doc No</th>
                      <th>Doc Date</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {depotEvents.map((ev) => {
                      const defQ = ev.defectiveQty ?? 0;
                      return (
                        <tr key={ev.eventId}>
                          <td className="whitespace-nowrap">{formatDisplayDate(new Date(ev.eventDate))}</td>
                          <td>
                            <Badge variant={ev.eventType === 'incoming_fulls' ? 'success' : 'warning'}>
                              {ev.eventType === 'incoming_fulls' ? 'Incoming' : 'Outgoing'}
                            </Badge>
                          </td>
                          <td className="font-medium">{ev.cylinderTypeName}</td>
                          <td>{ev.quantity}</td>
                          <td className={`text-right tabular-nums ${defQ > 0 ? 'text-amber-700 dark:text-amber-300 font-medium' : 'text-surface-400 text-xs'}`}>
                            {defQ > 0 ? `+${defQ}` : '—'}
                          </td>
                          <td className="text-right tabular-nums">{formatDepotAmount(ev.amount)}</td>
                          <td>{ev.vehicleNumber || '-'}</td>
                          <td>{ev.driverName || '-'}</td>
                          <td>{ev.documentType || '-'}</td>
                          <td>{ev.documentNumber || '-'}</td>
                          <td className="whitespace-nowrap">{ev.documentDate ? formatDisplayDate(new Date(ev.documentDate)) : '-'}</td>
                          <td className="max-w-[200px] truncate">{ev.notes || '-'}</td>
                        </tr>
                      );
                    })}
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

      {/* WI-080 F5 + Mini-Op (2026-07-16): opening stock — now has a
          "Set Opening Stock" button so mini-op tenants (who don't have
          Settings → Onboarding) can enter it. Existing rows stay read-only
          in the table but a top-right "Update" button opens the same modal
          with replaceExisting semantics (backend surfaces the conflict). */}
      {tab === 'onboarding' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-surface-500 dark:text-surface-400">
              Fulls and empties in your depot at go-live. Recorded once per
              cylinder type; drives Opening Fulls / Opening Empties on the
              Daily Summary tab.
            </p>
            <Button
              variant={onboardingStock?.length ? 'secondary' : 'primary'}
              size="sm"
              onClick={() => setOpeningStockOpen(true)}
            >
              <HiOutlinePlus className="h-4 w-4" />
              {onboardingStock?.length ? 'Update Opening Stock' : 'Set Opening Stock'}
            </Button>
          </div>
          {onboardingLoading ? (
            <div className="flex justify-center py-20"><Loader size="lg" /></div>
          ) : !onboardingStock?.length ? (
            <EmptyState
              title="No opening stock recorded yet"
              description="Click the button above to record how many fulls and empties are in your depot right now."
            />
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
                      <td className="text-surface-500 dark:text-surface-400">{formatDisplayDate(new Date(s.dateSet))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
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
                          <td>{formatDisplayDate(new Date(row.deliveryDate))}</td>
                          <td>{formatDisplayDate(new Date(row.createdAt))}</td>
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
                            <td>{formatDisplayDate(new Date(h.eventDate))}</td>
                            <td>{h.cylinderTypeName}</td>
                            <td className={fullsClass}>
                              {h.fullsChange !== 0 ? h.fullsChange : 0}
                            </td>
                            <td className={emptiesClass}>
                              {h.emptiesChange > 0 ? `+${h.emptiesChange}` : 0}
                            </td>
                            <td>{h.orderNumber ?? '—'}</td>
                            <td>{h.deliveryDate ? formatDisplayDate(new Date(h.deliveryDate)) : '—'}</td>
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

      {/* Item 7 (2026-07-09) — Empties Return Modal */}
      {emptiesReturnOpen && (
        <EmptiesReturnModal
          open={emptiesReturnOpen}
          onClose={() => setEmptiesReturnOpen(false)}
          cylinderTypes={cylinderTypes ?? []}
        />
      )}

      {/* F1 (2026-08-06) — Defective Return Modal. Sibling to Empties Return
          on Daily Summary. Compact 4-step flow inside a modal: customer →
          invoice + qty → confirm capture → raise CN. History + Send to
          Corp live on /app/defective-returns. */}
      {defectiveReturnOpen && (
        <DefectiveReturnModal
          open={defectiveReturnOpen}
          onClose={() => setDefectiveReturnOpen(false)}
        />
      )}

      {/* 2026-07-19 — Vehicles In Transit modal. Read-only quick view of
          every DVA currently on the road plus those reconciled today. */}
      {vehiclesInTransitOpen && (
        <VehiclesInTransitModal
          open={vehiclesInTransitOpen}
          onClose={() => setVehiclesInTransitOpen(false)}
        />
      )}

      {/* Mini-Op (2026-07-16) — Opening Stock modal. Reuses the modal
          from the Settings → Onboarding checklist so the mini-op path
          and the regular-distributor path emit the exact same payload
          to POST /api/inventory/initial-balance. */}
      {openingStockOpen && (
        <OpeningStockModal
          onClose={() => {
            setOpeningStockOpen(false);
            queryClient.invalidateQueries({ queryKey: ['onboarding-stock'] });
            queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
          }}
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
  | 'corp_in' | 'corp_out' | 'corp_dr_out'
  | 'open_f' | 'open_e'
  | 'veh_f' | 'veh_e'
  | 'cust_d' | 'cust_c' | 'cust_dr_in'
  | 'adj_r' | 'adj_m'
  | 'close_f' | 'close_e' | 'close_dr';

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
  // F1-FIX-15 (2026-08-06) — defective fulls shipped back to OMC today.
  // Sourced from InventorySummary.defectiveFullsOut (computed by the
  // Aug-6 aggregator extension). Amber to distinguish from the blue
  // regular-outgoing-empties column and match the CLOSING > Defective
  // colour. Non-zero rendered with a leading `−` so office reads it
  // as "left the depot".
  {
    key: 'corp_dr_out',
    group: 'CORPORATION',
    label: 'Defective Out',
    render: (i) => {
      const n = (i as { defectiveFullsOut?: number }).defectiveFullsOut ?? 0;
      return n > 0 ? `−${n}` : '0';
    },
    cellClass: (i) => ((i as { defectiveFullsOut?: number }).defectiveFullsOut ?? 0) > 0
      ? 'text-amber-700 dark:text-amber-300 font-medium'
      : 'text-surface-400 text-xs',
  },
  { key: 'open_f', group: 'OPENING', label: 'Fulls', render: (i) => i.openingFulls },
  { key: 'open_e', group: 'OPENING', label: 'Empties', render: (i) => i.openingEmpties },
  { key: 'veh_f', group: 'ON VEHICLE', label: 'Fulls', render: (i) => i.inFlightFulls ?? 0, cellClass: 'text-amber-700 dark:text-amber-300 font-medium' },
  { key: 'veh_e', group: 'ON VEHICLE', label: 'Empties', render: (i) => i.emptiesOnVehicle ?? 0, cellClass: 'text-amber-700 dark:text-amber-300' },
  { key: 'cust_d', group: 'AT CUSTOMER', label: 'Delivered Fulls', render: (i) => i.deliveredQty > 0 ? `${i.deliveredQty}` : '0', cellClass: 'text-teal-700 dark:text-teal-300' },
  { key: 'cust_c', group: 'AT CUSTOMER', label: 'Collected Empties', render: (i) => i.collectedEmpties, cellClass: 'text-teal-700 dark:text-teal-300' },
  // F1-FIX-15 (2026-08-06) — defective fulls picked up from customers
  // today. Sourced from InventorySummary.defectiveFullsIn. Leading `+`
  // signals inbound to depot's defective bucket.
  {
    key: 'cust_dr_in',
    group: 'AT CUSTOMER',
    label: 'Defective In',
    render: (i) => {
      const n = (i as { defectiveFullsIn?: number }).defectiveFullsIn ?? 0;
      return n > 0 ? `+${n}` : '0';
    },
    cellClass: (i) => ((i as { defectiveFullsIn?: number }).defectiveFullsIn ?? 0) > 0
      ? 'text-amber-700 dark:text-amber-300 font-medium'
      : 'text-surface-400 text-xs',
  },
  { key: 'adj_r', group: 'ADJUSTMENTS', label: 'Returned', render: (i) => i.cancelledStockQty, cellClass: 'text-flame-600 dark:text-flame-400' },
  {
    key: 'adj_m', group: 'ADJUSTMENTS', label: 'Manual',
    render: (i) => { const n = i.manualAdjustment; return n > 0 ? `+${n}` : n < 0 ? `${n}` : '0'; },
    cellClass: (i) => (i.manualAdjustment ?? 0) === 0 ? 'text-surface-400 text-xs' : 'font-medium',
  },
  { key: 'close_f', group: 'CLOSING', label: 'Fulls', render: (i) => i.closingFulls, cellClass: 'font-semibold' },
  { key: 'close_e', group: 'CLOSING', label: 'Empties', render: (i) => i.closingEmpties, cellClass: 'font-semibold' },
  // F1-FIX-13 (2026-08-06) — Defective bucket depot balance column. Per
  // Suneel: "now where can I see in daily summary defective items?".
  // Value from InventorySummary.closingDefectiveFulls, populated by the
  // Aug-6 computeSummaryForDate extension. Amber tint so it reads as
  // "attention needed" but not "critical". Falls back to 0 for tenants
  // that have never had a defective row.
  {
    key: 'close_dr',
    group: 'CLOSING',
    label: 'Defective',
    render: (i) => (i as { closingDefectiveFulls?: number }).closingDefectiveFulls ?? 0,
    cellClass: (i) => ((i as { closingDefectiveFulls?: number }).closingDefectiveFulls ?? 0) > 0
      ? 'font-semibold text-amber-700 dark:text-amber-300'
      : 'text-surface-400 text-xs',
  },
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
  // Mini-Operator (2026-07-16): sub-component reads role directly so the
  // "CORPORATION → PURCHASE" header relabel doesn't require a new prop
  // through every DailySummary callsite.
  const role = useAuthStore(selectRole);
  const isMiniOperator = role === 'mini_operator_admin';
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
                  {/* Mini-Operator: relabel "CORPORATION" → "PURCHASE"
                      because mini-op supply comes from their listed source
                      distributors, not a corporation refill. Data stays
                      the same; only the header column band changes. */}
                  {isMiniOperator && g.name === 'CORPORATION' ? 'PURCHASE' : g.name}
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

      {/* D1-followup (2026-07-10) — total fulls returning summary.
          Suneel's testing: operator was mentally summing CSE lines (3) +
          Spare Returning (4) = 7 to verify against physical truck count.
          Surface the total explicitly so the check is one glance not
          three mental steps. Split by category so if any single number
          looks wrong, the operator knows which section to look at. */}
      {(lines.length > 0 || (vehicle.floatSummary ?? []).length > 0) && (() => {
        const cseSum = lines.reduce((s, l) => s + (l.shortfallQty ?? 0), 0);
        const spareSum = (vehicle.floatSummary ?? []).reduce((s, f) => s + (f.unsoldFloat ?? 0), 0);
        const total = cseSum + spareSum;
        if (total <= 0) return null;
        return (
          <div className="mb-5 rounded-lg border border-flame-200 dark:border-flame-800 bg-flame-50 dark:bg-flame-950/40 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-flame-900 dark:text-flame-200">
                Total fulls returning to depot
              </div>
              <div className="text-2xl font-bold text-flame-700 dark:text-flame-300">
                {total}
              </div>
            </div>
            <div className="text-xs text-flame-800/80 dark:text-flame-300/80 mt-1">
              {cseSum} from cancelled stock + {spareSum} spare = {total} — verify against physical count on the truck.
            </div>
          </div>
        );
      })()}

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
                        <td className="px-3 py-2 text-surface-600 dark:text-surface-400 whitespace-nowrap">{formatDisplayDate(new Date(r.eventDate))}</td>
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

// F8v2-FIX-A (2026-08-06) — exported so CorporationLedgerPage's Add Entry
// dropdown opens the SAME modal (Suneel's "no need to redirect just open
// the same" ask). Callers pass their own cylinderTypes/vehicles/drivers
// arrays so the modal stays a pure prop-driven component.
export function IncomingFullsModal({
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
    defaultValues: {
      cylinderTypeId: '',
      quantity: 1,
      documentType: '',
      documentNumber: '',
      documentDate: date,
      charges: [],
    },
  });
  const { fields: chargeFields, append: appendCharge, remove: removeCharge } = useFieldArray({
    control,
    name: 'charges',
  });

  const mutation = useMutation({
    mutationFn: (data: IncomingFullsInput) => apiPost('/inventory/incoming-fulls', data),
    onSuccess: () => {
      toast.success('Incoming fulls recorded');
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      // F8: also refresh supplier ledger + purchase list downstream consumers.
      queryClient.invalidateQueries({ queryKey: ['source-distributors'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-entries'] });
      // 2026-08-15 — a sourced incoming creates a PurchaseEntry that feeds the
      // FIFO cost-layer ledger + avg-landed + supplier balances. Without these
      // the Cost Layer panel stayed stale (missing the just-added load).
      // Keys match the Corp. Loads page (CorporationLedgerPage): the FIFO panel
      // reads ['corp-cost-layers']; mobile corp uses ['cost-layers'].
      queryClient.invalidateQueries({ queryKey: ['corp-cost-layers'] });
      queryClient.invalidateQueries({ queryKey: ['cost-layers'] });
      queryClient.invalidateQueries({ queryKey: ['corp-avg-landed'] });
      queryClient.invalidateQueries({ queryKey: ['corp-landed-cost'] });
      queryClient.invalidateQueries({ queryKey: ['corp-ledger'] });
      queryClient.invalidateQueries({ queryKey: ['supplier-balances-v2'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  // F8 (2026-08-06) — supplier list for the Source (OMC) picker. Fetched
  // only when the modal is open. On tenants with a single supplier the
  // picker is hidden and sourceDistributorId is auto-set (per Suneel Q3).
  const { data: suppliers } = useQuery({
    queryKey: ['source-distributors'],
    queryFn: () => apiGet<Array<{ id: string; name: string }>>('/source-distributors'),
    enabled: open,
  });
  const activeSuppliers = suppliers ?? [];
  const singleSupplier = activeSuppliers.length === 1 ? activeSuppliers[0] : null;
  useEffect(() => {
    if (singleSupplier) {
      setValue('sourceDistributorId', singleSupplier.id, { shouldDirty: false });
    }
  }, [singleSupplier, setValue]);

  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: ct.typeName }));
  const supplierOptions = activeSuppliers.map((s) => ({ value: s.id, label: s.name }));
  const vehicleOptions = vehicles.map((v) => ({ value: v.vehicleId, label: v.vehicleNumber }));
  const driverOptions = drivers.map((d) => ({ value: d.driverName, label: d.driverName }));

  // 2026-08-15 — invoice-value entry. The user types the GST-EXCLUSIVE Taxable
  // Value off the OMC invoice and picks the GST%; each charge carries its own
  // GST%. We derive the per-cylinder costs live. Downstream convention:
  // cost/margin use the EXCL base (+ freight base); GST is reclaimable ITC;
  // supplier payables use the full GST-inclusive total.
  const taxableValue = useWatch({ control, name: 'taxableValue' });
  const gstRatePct = useWatch({ control, name: 'gstRate' });
  const chargesW = useWatch({ control, name: 'charges' });
  const qty = useWatch({ control, name: 'quantity' });
  const fmt = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const calc = useMemo(() => {
    const tax = Math.max(0, Number(taxableValue) || 0);
    const gst = Math.max(0, Number(gstRatePct) || 0);
    const q = Math.max(0, Number(qty) || 0);
    const cylGst = (tax * gst) / 100;
    const list = chargesW ?? [];
    const chargeBase = list.reduce((s, c) => s + Math.max(0, Number(c?.amount) || 0), 0);
    const chargeGst = list.reduce(
      (s, c) => s + Math.max(0, Number(c?.amount) || 0) * (Math.max(0, Number(c?.gstRate) || 0) / 100), 0);
    const landed = tax + cylGst + chargeBase + chargeGst;
    return {
      q,
      perBase: q ? tax / q : 0,
      perExpense: q ? chargeBase / q : 0,
      perGst: q ? (cylGst + chargeGst) / q : 0,
      perLanded: q ? landed / q : 0,
      payable: landed,
    };
  }, [taxableValue, gstRatePct, chargesW, qty]);

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
        {/* F8 (2026-08-06) — Source (OMC) picker. Suneel Q3: hidden when the
            tenant has exactly one licensed supplier; a small read-only label
            confirms which supplier the entry is being recorded against. */}
        {singleSupplier ? (
          <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
            Source: <span className="font-medium">{singleSupplier.name}</span>
          </div>
        ) : activeSuppliers.length > 1 ? (
          <Select
            label="Source (OMC)"
            options={supplierOptions}
            placeholder="Select supplier"
            required
            error={errors.sourceDistributorId?.message}
            {...register('sourceDistributorId')}
          />
        ) : null}
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
        {/* 2026-08-15 — invoice-value money entry. Type the GST-EXCLUSIVE
            Taxable Value off the OMC invoice + pick GST%; charges carry their
            own GST%. Per-cylinder costs derive live in the readout below. */}
        <Input
          label="Taxable Value (₹, excl GST)"
          type="number"
          min={0}
          step="0.01"
          placeholder="Line total before GST — copy from invoice"
          error={errors.taxableValue?.message}
          {...register('taxableValue', {
            setValueAs: (v) => v === '' || v === null || v === undefined ? undefined : Number(v),
          })}
        />
        <div>
          <label className="text-sm font-medium text-slate-700">GST %</label>
          <div className="mt-1 flex items-center gap-2">
            {[5, 18].map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setValue('gstRate', r, { shouldDirty: true })}
                className={`px-3.5 py-2 rounded-md text-sm font-medium border ${
                  Number(gstRatePct) === r
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-slate-700 border-slate-300 hover:border-blue-400'
                }`}
              >
                {r}%
              </button>
            ))}
            <div className="flex-1">
              <Input
                type="number"
                min={0}
                max={28}
                step="0.01"
                placeholder="Custom %"
                error={errors.gstRate?.message}
                {...register('gstRate', {
                  setValueAs: (v) => v === '' || v === null || v === undefined ? undefined : Number(v),
                })}
              />
            </div>
          </div>
          <p className="mt-1 text-xs text-slate-500">5% domestic LPG · 18% commercial — applies to this line, pick per invoice.</p>
        </div>
        {/* Charges — each carries its own GST% (freight on some OMC invoices is
            taxed at the goods rate, e.g. GoGas freight @ 5%). */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-slate-700">Charges (freight, handling, etc.)</label>
            <Button
              type="button"
              variant="secondary"
              onClick={() => appendCharge({ chargeType: 'freight', amount: 0, gstRate: Number(gstRatePct) || 0 })}
            >
              + Add charge
            </Button>
          </div>
          {chargeFields.length === 0 ? (
            <p className="text-xs text-slate-500">No extra charges. Freight / handling can be added if the OMC billed them separately or on the same challan.</p>
          ) : (
            <div className="space-y-2">
              {chargeFields.map((f, i) => (
                <div key={f.id} className="grid grid-cols-[1fr_1fr_78px_auto] gap-2 items-end">
                  <Select
                    label={i === 0 ? 'Type' : undefined}
                    options={[
                      { value: 'freight', label: 'Freight' },
                      { value: 'handling', label: 'Handling' },
                      { value: 'testing', label: 'Testing' },
                      { value: 'insurance', label: 'Insurance' },
                      { value: 'other', label: 'Other' },
                    ]}
                    {...register(`charges.${i}.chargeType` as const)}
                  />
                  <Input
                    label={i === 0 ? 'Amount (₹, excl GST)' : undefined}
                    type="number"
                    min={0}
                    step="0.01"
                    {...register(`charges.${i}.amount` as const, { valueAsNumber: true })}
                  />
                  <Input
                    label={i === 0 ? 'GST %' : undefined}
                    type="number"
                    min={0}
                    max={28}
                    step="0.01"
                    {...register(`charges.${i}.gstRate` as const, {
                      setValueAs: (v) => v === '' || v === null || v === undefined ? undefined : Number(v),
                    })}
                  />
                  <Button type="button" variant="secondary" onClick={() => removeCharge(i)}>Remove</Button>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* Live per-cylinder readout */}
        {calc.q > 0 && (Number(taxableValue) || 0) > 0 && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-slate-600">Base / cyl (excl GST)</span><span className="font-semibold tabular-nums">{fmt(calc.perBase)}</span></div>
            {calc.perExpense > 0 && (
              <div className="flex justify-between"><span className="text-slate-600">+ Expense / cyl (freight etc.)</span><span className="font-semibold tabular-nums">{fmt(calc.perExpense)}</span></div>
            )}
            <div className="flex justify-between"><span className="text-slate-600">GST / cyl (reclaimable ITC)</span><span className="font-semibold tabular-nums text-slate-500">{fmt(calc.perGst)}</span></div>
            <div className="flex justify-between border-t border-slate-200 pt-1"><span className="text-slate-800 font-medium">Landed / cyl (incl GST + expenses)</span><span className="font-bold tabular-nums">{fmt(calc.perLanded)}</span></div>
            <div className="flex justify-between"><span className="text-slate-600">Payable to supplier (total)</span><span className="font-semibold tabular-nums">{fmt(calc.payable)}</span></div>
          </div>
        )}
        <p className="text-xs text-slate-500">
          Downstream: cost &amp; margin use the <b>GST-exclusive base</b> (+ freight base); GST is <b>reclaimable ITC</b> shown separately; supplier payables use the full <b>GST-inclusive</b> total.
        </p>
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
// F8v2-FIX-A (2026-08-06) — exported for CorporationLedgerPage reuse (same
// modal opens from both Inventory + Corp surfaces). Contains F1 defective-
// return-inclusion flow so Corp's Add Entry → Outgoing Empties gets it too.

export function OutgoingEmptiesModal({
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
  const { register, handleSubmit, control, setValue, formState: { errors }, getValues } = useForm<OutgoingEmptiesInput>({
    resolver: zodResolver(outgoingEmptiesSchema),
    defaultValues: { cylinderTypeId: '', quantity: 1, documentType: '', documentNumber: '', documentDate: date },
  });

  // F1-FIX-12 (2026-08-06) — include-defectives section state. When user
  // ticks the box, per-cyl-type checkboxes show below with the CN-issued
  // rows ready to ship (Suneel spec: "checkbox to add defective cylinders
  // — then show how many defective per cyl type from collected defectives
  // and once added in outgoing corp loads they get moved to sent to
  // corporation"). Server call is chained after the empties record so
  // office sees them as one operation.
  const [includeDefectives, setIncludeDefectives] = useState(false);
  const [selectedDefectiveIds, setSelectedDefectiveIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

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

  // F1-FIX-12 (2026-08-06) — depot bucket + CN-issued rows for the
  // include-defectives section. Fetched only when modal is open.
  const { data: defectiveBucket } = useQuery({
    queryKey: ['defective-depot-bucket'],
    queryFn: () => apiGet<Array<{ cylinderTypeId: string; cylinderTypeName: string; qty: number }>>('/defective-returns/depot-bucket'),
    enabled: open,
  });
  const { data: readyDefectives } = useQuery({
    queryKey: ['defective-returns-history', 'cn_issued'],
    queryFn: () => apiGet<DefectiveReturn[]>('/defective-returns', { status: 'cn_issued' }),
    enabled: open,
  });
  const defectiveTotalQty = (defectiveBucket ?? []).reduce((s, b) => s + b.qty, 0);
  const selectedDefectiveQty = useMemo(() => {
    if (!readyDefectives) return 0;
    return readyDefectives.filter((r) => selectedDefectiveIds.has(r.id)).reduce((s, r) => s + r.quantity, 0);
  }, [readyDefectives, selectedDefectiveIds]);

  // Group ready defective rows by cyl type for the checkbox UI.
  const defectivesByType = useMemo(() => {
    const m = new Map<string, { cylTypeName: string; rows: DefectiveReturn[] }>();
    for (const r of readyDefectives ?? []) {
      const key = r.cylinderTypeId;
      const existing = m.get(key);
      if (existing) {
        existing.rows.push(r);
      } else {
        m.set(key, { cylTypeName: r.cylinderTypeName ?? '—', rows: [r] });
      }
    }
    return m;
  }, [readyDefectives]);

  // Combined submit: empties record, then (if requested) defective batch.
  // Empties failure blocks entirely. Defective failure produces a WARNING
  // toast — the empties record still landed.
  const onSubmit = handleSubmit(async (data) => {
    setSubmitting(true);
    try {
      await apiPost('/inventory/outgoing-empties', data);
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
    } catch (err) {
      toast.error(getErrorMessage(err));
      setSubmitting(false);
      return;
    }

    // Empties succeeded. If defectives were ticked, fire the batch.
    if (includeDefectives && selectedDefectiveIds.size > 0) {
      try {
        const batch = await apiPost<{ batchNumber: string; totalQuantity: number }>('/defective-returns/batches', {
          // Corporation name defaults from the outgoing empties documentType
          // (freeform) — Suneel spec says the corp identity isn't a hard
          // requirement here. Fall back to 'IOCL' if user didn't type
          // anything indicative.
          corporationName: (getValues('documentType') || 'IOCL').slice(0, 60),
          challanNumber: getValues('documentNumber') || undefined,
          challanDate: getValues('documentDate') || undefined,
          defectiveIds: Array.from(selectedDefectiveIds),
          notes: `Piggybacked on outgoing empties challan ${getValues('documentNumber') ?? ''}`.trim(),
        });
        queryClient.invalidateQueries({ queryKey: ['defective-depot-bucket'] });
        queryClient.invalidateQueries({ queryKey: ['defective-returns-history'] });
        queryClient.invalidateQueries({ queryKey: ['defective-returns-pending-count'] });
        // No internal FSHD batch number in operator-facing copy.
        toast.success(`Recorded — empties + ${batch.totalQuantity} defective cyl sent`);
      } catch (err) {
        toast.error(`Empties recorded but defective batch failed: ${getErrorMessage(err)}. Defectives still in bucket — retry from Outgoing Empties.`, { duration: 10_000 });
      }
    } else {
      toast.success('Outgoing empties recorded');
    }

    setSubmitting(false);
    setIncludeDefectives(false);
    setSelectedDefectiveIds(new Set());
    onClose();
  });

  return (
    <Modal open={open} onClose={onClose} title="Record Outgoing Empties">
      <form onSubmit={onSubmit} className="space-y-4">
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
        {/* Condition (good/defective) removed 2026-08-15 — it was write-only,
            never read by any report/logic. Defective handling lives in the
            "include defective fulls" section below (real F1 flow). */}
        <Input label="Notes" placeholder="Optional notes" {...register('notes')} />

        {/* F1-FIX-12 (2026-08-06) — Include defective fulls in this
            shipment. Only rendered when depot has CN-issued defective
            rows ready to ship. Per-cyl-type checkbox with count; ticked
            rows are shipped alongside the empties record in one submit. */}
        {defectiveTotalQty > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-600 p-3 space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeDefectives}
                onChange={(e) => {
                  setIncludeDefectives(e.target.checked);
                  if (!e.target.checked) setSelectedDefectiveIds(new Set());
                }}
                className="h-4 w-4"
              />
              <span className="text-sm font-medium text-amber-900 dark:text-amber-200">
                Also include defective fulls
                <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">
                  ({defectiveTotalQty} pending at depot)
                </span>
              </span>
            </label>
            {includeDefectives && (
              <div className="pl-6 space-y-2">
                {[...defectivesByType.entries()].map(([cylTypeId, { cylTypeName, rows }]) => {
                  const rowsSelected = rows.filter((r) => selectedDefectiveIds.has(r.id));
                  const allTicked = rowsSelected.length === rows.length && rows.length > 0;
                  const qty = rowsSelected.reduce((s, r) => s + r.quantity, 0);
                  const totalQty = rows.reduce((s, r) => s + r.quantity, 0);
                  return (
                    <label key={cylTypeId} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allTicked}
                        onChange={(e) => {
                          const next = new Set(selectedDefectiveIds);
                          if (e.target.checked) rows.forEach((r) => next.add(r.id));
                          else rows.forEach((r) => next.delete(r.id));
                          setSelectedDefectiveIds(next);
                        }}
                        className="h-4 w-4"
                      />
                      <span className="text-amber-900 dark:text-amber-200">
                        {cylTypeName}: <span className="font-semibold">{totalQty}</span> defective ready
                      </span>
                      {qty > 0 && qty < totalQty && (
                        <span className="text-xs text-amber-700 dark:text-amber-300">({qty} selected)</span>
                      )}
                    </label>
                  );
                })}
                {selectedDefectiveQty > 0 && (
                  <div className="text-xs text-amber-800 dark:text-amber-300 pt-1 border-t border-amber-200 dark:border-amber-700">
                    Total to ship: <span className="font-semibold">{selectedDefectiveQty} defective cyl(s)</span> — will move to &ldquo;sent to corporation&rdquo; on submit
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={submitting}>Record</Button>
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
  // 2026-08-06: hoisted into useCallback so it can be safely used inside the
  // rows useMemo without triggering react-hooks/exhaustive-deps.
  const daysSince = useCallback(
    (d?: string | null): number | null =>
      d ? Math.floor((now - new Date(d).getTime()) / 86400000) : null,
    [now],
  );
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
  }, [balances, onlyOutstanding, search, typeFilter, sortKey, sortDir, daysSince]);

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

// ─── Empties Return Modal (Item 7 — 2026-07-09) ─────────────────────────────
//
// Lightweight customer-empties-return flow. No order, no invoice, no money.
// Pure stock movement backed by two InventoryEvent rows (see
// packages/api/src/services/emptiesReturnService.ts). Locked inventory days
// silently skip in the summary cascade — copy warns the operator.

// ─── Vehicles In Transit Modal (2026-07-19) ─────────────────────────────────
// Read-only quick view. Fetches GET /api/inventory/vehicles-in-transit and
// renders one card per DVA — vehicle + driver + dispatch time + per-cyl-type
// loaded / delivered / empties-back / remaining. Reconciled-today rows stay
// visible but tagged with a green "Reconciled" badge and dimmed styling so
// the operator can see final settled state alongside still-open trips.
interface VehicleInTransitType {
  cylinderTypeId: string;
  typeName: string;
  loaded: number;
  delivered: number;
  emptiesBack: number;
}
interface VehicleInTransitRow {
  dvaId: string;
  vehicleNumber: string;
  driverName: string;
  dispatchedAt: string | null;
  returnedAt: string | null;
  reconciledAt: string | null;
  status: 'in_transit' | 'returned' | 'reconciled';
  types: VehicleInTransitType[];
}

function VehiclesInTransitModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['vehicles-in-transit'],
    queryFn: () => apiGet<{ vehicles: VehicleInTransitRow[] }>('/inventory/vehicles-in-transit'),
    enabled: open,
    refetchInterval: 30_000,
  });
  const vehicles = data?.vehicles ?? [];

  const fmtTime = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const statusBadge = (s: VehicleInTransitRow['status']) => {
    if (s === 'reconciled') return <Badge variant="success">✓ Reconciled</Badge>;
    if (s === 'returned') return <Badge variant="warning">Returned</Badge>;
    return <Badge variant="info">In Transit</Badge>;
  };

  return (
    <Modal open={open} onClose={onClose} title="Vehicles In Transit" size="xl">
      {isLoading && (
        <div className="flex justify-center py-8"><Loader size="lg" /></div>
      )}
      {error && (
        <div className="text-sm text-red-600 dark:text-red-400 py-4">
          Failed to load vehicles: {getErrorMessage(error)}
        </div>
      )}
      {!isLoading && !error && vehicles.length === 0 && (
        <EmptyState
          title="No vehicles in transit"
          description="Dispatched vehicles will appear here until reconciled. Reconciled trips remain visible until the end of the day."
        />
      )}
      {!isLoading && !error && vehicles.length > 0 && (
        <div className="space-y-4">
          {vehicles.map((v) => (
            <div
              key={v.dvaId}
              className={`rounded-lg border p-4 ${
                v.status === 'reconciled'
                  ? 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-800/40 dark:bg-emerald-900/10'
                  : 'border-surface-200 dark:border-surface-700'
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="font-semibold text-surface-900 dark:text-white">
                    Vehicle {v.vehicleNumber}
                  </div>
                  <div className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
                    Driver: {v.driverName} · Dispatched {fmtTime(v.dispatchedAt)}
                    {v.reconciledAt && ` · Reconciled ${fmtTime(v.reconciledAt)}`}
                  </div>
                </div>
                {statusBadge(v.status)}
              </div>
              <div className="overflow-x-auto">
                <table className="table-simple w-full text-sm">
                  <thead>
                    <tr>
                      <th className="text-left">Cylinder Type</th>
                      <th className="text-right">Loaded</th>
                      <th className="text-right">Delivered</th>
                      <th className="text-right">Empties Back</th>
                      <th className="text-right">On Truck</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.types.map((t) => {
                      const onTruck = t.loaded - t.delivered;
                      return (
                        <tr key={t.cylinderTypeId}>
                          <td>{t.typeName || <span className="text-surface-400 italic">Untracked type</span>}</td>
                          <td className="text-right">{t.loaded}</td>
                          <td className="text-right">{t.delivered}</td>
                          <td className="text-right">{t.emptiesBack}</td>
                          <td className="text-right font-medium">{onTruck}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// F1-FIX-9b (2026-08-06) — Empties Return modal, tabbed like Defective /
// Adjust Stock. Per Suneel: "hope you will do same for empties modal too".
// Tabs: New Return | History. Same size + layout convention.

interface EmptiesHistoryRow {
  id: string;
  returnDate: string;
  customerId: string | null;
  customerName: string;
  cylinderTypeId: string;
  cylinderTypeName: string;
  quantity: number;
  notes: string | null;
  createdAt: string;
}

function EmptiesReturnModal({
  open,
  onClose,
  cylinderTypes,
}: {
  open: boolean;
  onClose: () => void;
  cylinderTypes: CylinderType[];
}) {
  const [tab, setTab] = useState<'new' | 'history'>('new');
  return (
    <Modal open={open} onClose={onClose} title="Empties Return" size="xl">
      <div className="min-w-[720px] min-h-[560px]">
        <div className="flex border-b border-surface-200 dark:border-surface-700 mb-4">
          <TabHeaderButton active={tab === 'new'} onClick={() => setTab('new')}>
            New Return
          </TabHeaderButton>
          <TabHeaderButton active={tab === 'history'} onClick={() => setTab('history')}>
            History
          </TabHeaderButton>
        </div>
        {tab === 'new' && (
          <EmptiesNewReturnTab
            cylinderTypes={cylinderTypes}
            onDone={() => setTab('history')}
          />
        )}
        {tab === 'history' && <EmptiesHistoryTab />}
      </div>
    </Modal>
  );
}

function EmptiesNewReturnTab({
  cylinderTypes,
  onDone,
}: {
  cylinderTypes: CylinderType[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const cylinderOptions = useMemo(() =>
    cylinderTypes.map((c) => ({ value: c.cylinderTypeId, label: c.typeName })),
  [cylinderTypes]);

  const {
    register, handleSubmit, watch, setValue, reset,
    formState: { errors },
  } = useForm<EmptiesReturnInput>({
    resolver: zodResolver(emptiesReturnSchema),
    defaultValues: {
      customerId: '',
      cylinderTypeId: '',
      quantity: 1,
      returnDate: localTodayISO(),
      notes: '',
    },
  });

  const customerId = watch('customerId');

  const mutation = useMutation({
    mutationFn: (data: EmptiesReturnInput) => apiPost('/inventory/empties-return', data),
    onSuccess: () => {
      toast.success('Empties return recorded');
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['customer-balances'] });
      queryClient.invalidateQueries({ queryKey: ['inventory-events'] });
      queryClient.invalidateQueries({ queryKey: ['empties-return-history'] });
      reset();
      onDone();
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err));
    },
  });

  // 90-day back range for the date picker.
  const minDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return localDateISO(d);
  }, []);

  return (
    <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
      {/* Row 1 — customer full width */}
      <CustomerSearchInput
        value={customerId}
        onChange={(id) => setValue('customerId', id, { shouldValidate: true })}
        label="Customer"
        required
        error={errors.customerId?.message}
      />
      {/* Row 2 — cyl type + qty */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Select
          label="Cylinder Type"
          options={cylinderOptions}
          placeholder="Select cylinder type"
          required
          error={errors.cylinderTypeId?.message}
          {...register('cylinderTypeId')}
        />
        <Input
          label="Quantity"
          type="number"
          min={1}
          required
          error={errors.quantity?.message}
          {...register('quantity', { valueAsNumber: true })}
        />
      </div>
      {/* Row 3 — date + notes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Input
          label="Return Date"
          type="date"
          min={minDate}
          max={localTodayISO()}
          required
          error={errors.returnDate?.message}
          {...register('returnDate')}
        />
        <Input label="Notes" placeholder="Optional notes" {...register('notes')} />
      </div>
      <p className="text-xs text-surface-500 dark:text-surface-400">
        The daily summary will be recalculated from the return date forward.
        Locked days between the return date and today are skipped in the
        cascade — unlock them first if you need those days recomputed.
      </p>
      <div className="flex justify-end gap-3 pt-2">
        <Button type="submit" loading={mutation.isPending}>Record</Button>
      </div>
    </form>
  );
}

function EmptiesHistoryTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['empties-return-history'],
    queryFn: () => apiGet<EmptiesHistoryRow[]>('/inventory/empties-return-history', { limit: 100 }),
  });

  return (
    <div className="space-y-3">
      <div className="text-sm text-surface-500 dark:text-surface-400">
        {data ? `${data.length} row${data.length === 1 ? '' : 's'} · latest 100` : ''}
      </div>
      {isLoading && <div className="text-center py-6"><Loader /></div>}
      {!isLoading && (!data || data.length === 0) && (
        <EmptyState title="No empties returns yet" description="Recorded returns will appear here." />
      )}
      {!isLoading && data && data.length > 0 && (
        <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-surface-200 dark:border-surface-700 text-left text-xs text-surface-500 dark:text-surface-400 uppercase">
                <th className="py-2 pr-3">Date</th>
                <th className="py-2 pr-3">Customer</th>
                <th className="py-2 pr-3">Cyl Type</th>
                <th className="py-2 pr-3 text-right">Qty</th>
                <th className="py-2 pr-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.id} className="border-b border-surface-100 dark:border-surface-800/50">
                  <td className="py-2 pr-3">{row.returnDate}</td>
                  <td className="py-2 pr-3 font-medium">{row.customerName}</td>
                  <td className="py-2 pr-3">{row.cylinderTypeName}</td>
                  <td className="py-2 pr-3 text-right font-medium">{row.quantity}</td>
                  <td className="py-2 pr-3 text-xs text-surface-500 dark:text-surface-400">{row.notes ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── F1 (2026-08-06) — Defective Return button with inline pending-CN chip ──
// Replaces the sidebar chip (removed per Suneel 2026-08-06 pm). Same 60s
// refetch cadence as the payments pending-count badge on Billing.

function DefectiveReturnButton({ onClick }: { onClick: () => void }) {
  const { data } = useQuery({
    queryKey: ['defective-returns-pending-count'],
    queryFn: () => apiGet<{ count: number }>('/defective-returns/pending-count'),
    refetchInterval: 60_000,
  });
  const pending = data?.count ?? 0;
  return (
    <Button variant="secondary" size="sm" onClick={onClick}>
      <HiOutlinePlus className="h-4 w-4" />Defective Return
      {pending > 0 && (
        <span
          className="ml-1 inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold"
          aria-label={`${pending} defective row(s) with pending CN`}
          title={`${pending} defective row(s) captured, CN not yet raised — click to review from History`}
        >
          {pending > 99 ? '99+' : pending}
        </span>
      )}
    </Button>
  );
}

// ─── F1-FIX-9 (2026-08-06) — Defective Return Modal, redesigned ─────────────
// Modelled after AdjustStockModal: xl size, min 720×560, tabbed strip at the
// top (New Return | History | Send to Corp). Suneel spec: "design it like
// [adjust stock] modal", "want it all in same modal", cleaner layout.
//
// TABS:
//   1. New Return — customer picker → invoice Select dropdown → per-line
//      quantity grid → one-shot Record & Raise CN button.
//   2. History — table with all past defective returns, per-row Raise CN
//      (if status='collected') / Cancel actions.
//   3. Send to Corp — depot bucket cards + checkbox picker of ready rows +
//      record shipment (F-prefixed batch number allocated server-side).
//
// The standalone /app/defective-returns page is kept for URL-based access
// but the sidebar entry is deleted and everything real happens here.

function DefectiveReturnModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'new' | 'history'>('new');

  // F1-FIX-11 (2026-08-06) — Send-to-Corp tab REMOVED per Suneel. Shipping
  // defective back to corp now happens inline in Record Outgoing Empties
  // modal (see the DefectivesToShipSection in OutgoingEmptiesModal below).
  // Two tabs left: New Return + History. Poll pending-CN count for the
  // History-tab badge.
  const { data: pendingData } = useQuery({
    queryKey: ['defective-returns-pending-count'],
    queryFn: () => apiGet<{ count: number }>('/defective-returns/pending-count'),
    enabled: open,
    refetchInterval: open ? 30_000 : false,
  });
  const pendingCount = pendingData?.count ?? 0;

  return (
    <Modal open={open} onClose={onClose} title="Defective Returns" size="xl">
      <div className="min-w-[720px] min-h-[560px]">
        <div className="flex border-b border-surface-200 dark:border-surface-700 mb-4">
          <TabHeaderButton active={tab === 'new'} onClick={() => setTab('new')}>
            New Return
          </TabHeaderButton>
          <TabHeaderButton
            active={tab === 'history'}
            onClick={() => setTab('history')}
            badge={pendingCount || undefined}
          >
            History
          </TabHeaderButton>
        </div>

        {tab === 'new' && <DefectiveNewTab onDone={() => setTab('history')} />}
        {tab === 'history' && <DefectiveHistoryTab />}
      </div>
    </Modal>
  );
}

function TabHeaderButton({
  active, onClick, badge, children,
}: { active: boolean; onClick: () => void; badge?: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px inline-flex items-center gap-1.5 ${
        active
          ? 'border-brand-500 text-brand-600 dark:text-brand-400'
          : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300'
      }`}
    >
      {children}
      {badge != null && badge > 0 && (
        <span className="inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

// ─── Tab 1 — New Return ─────────────────────────────────────────────────────

function DefectiveNewTab({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [customerId, setCustomerId] = useState('');
  const [chosenInvoiceId, setChosenInvoiceId] = useState('');
  const [selectedQtys, setSelectedQtys] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [collectedDate, setCollectedDate] = useState(() => localTodayISO());
  const [busy, setBusy] = useState(false);

  const { data: invoices, isLoading: invLoading } = useQuery({
    queryKey: ['defective-eligible-invoices', customerId],
    queryFn: () => apiGet<DefectiveEligibleInvoice[]>('/defective-returns/eligible-invoices', { customerId }),
    enabled: !!customerId,
  });

  const chosenInvoice = invoices?.find((i) => i.invoiceId === chosenInvoiceId);
  const previewAmount = useMemo(() => {
    if (!chosenInvoice) return 0;
    return Object.entries(selectedQtys).reduce((sum, [cylTypeId, qty]) => {
      const line = chosenInvoice.lines.find((l) => l.cylinderTypeId === cylTypeId);
      return sum + (line ? qty * line.perCylRate : 0);
    }, 0);
  }, [chosenInvoice, selectedQtys]);
  const hasAnyQty = Object.values(selectedQtys).some((q) => q > 0);

  const resetForm = () => {
    setCustomerId(''); setChosenInvoiceId('');
    setSelectedQtys({}); setReason(''); setNotes('');
    setCollectedDate(localTodayISO());
    setBusy(false);
  };

  const submit = async () => {
    if (!chosenInvoice) return;
    const items = Object.entries(selectedQtys)
      .filter(([, q]) => q > 0)
      .map(([cylTypeId, quantity]) => ({ cylinderTypeId: cylTypeId, quantity }));
    if (items.length === 0) { toast.error('Enter at least one defective quantity'); return; }
    setBusy(true);
    let cap: { defectiveIds: string[]; cnAmountPreview: number } | null = null;
    try {
      cap = await apiPost<{ defectiveIds: string[]; cnAmountPreview: number }>('/defective-returns', {
        customerId, sourceInvoiceId: chosenInvoiceId, collectedDate, items,
        reason: reason.trim() || undefined,
        notes: notes.trim() || undefined,
      });
    } catch (err) {
      toast.error(getErrorMessage(err));
      setBusy(false);
      return;
    }
    try {
      const cn = await apiPost<{ creditNoteId: string; cnNumber: string; cnAmount: number }>(
        `/defective-returns/${cap.defectiveIds[0]}/raise-cn`,
        { defectiveIds: cap.defectiveIds, reason: 'Defective cylinder return' },
      );
      queryClient.invalidateQueries({ queryKey: ['defective-returns-pending-count'] });
      queryClient.invalidateQueries({ queryKey: ['defective-returns-history'] });
      queryClient.invalidateQueries({ queryKey: ['defective-depot-bucket'] });
      queryClient.invalidateQueries({ queryKey: ['defective-eligible-invoices', customerId] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['customer-balances'] });
      toast.success(`✓ Defective recorded + CN ${cn.cnNumber} raised for ₹${cn.cnAmount.toLocaleString('en-IN')}`);
      resetForm();
      onDone();
    } catch (err) {
      queryClient.invalidateQueries({ queryKey: ['defective-returns-pending-count'] });
      queryClient.invalidateQueries({ queryKey: ['defective-returns-history'] });
      toast.error(
        `Defective captured but CN raise failed: ${getErrorMessage(err)}. ` +
        `Fix and click "Raise CN" from History tab.`,
        { duration: 10_000 },
      );
      setBusy(false);
      onDone();
    }
  };

  // Invoice picker as a Select dropdown (cleaner than radio grid).
  const invoiceOptions = (invoices ?? []).map((inv) => ({
    value: inv.invoiceId,
    label: `${inv.invoiceNumber} · ${inv.issueDate} · ₹${inv.totalAmount.toLocaleString('en-IN')} · ${inv.paymentStatus}`,
  }));

  return (
    <div className="space-y-4">
      {/* Row 1 — Customer + Invoice */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="label">Customer</label>
          <CustomerSearchInput
            value={customerId}
            onChange={(id) => {
              setCustomerId(id);
              setChosenInvoiceId('');
              setSelectedQtys({});
            }}
            placeholder="Search customer by name or phone..."
          />
        </div>
        <div>
          <label className="label">Source Invoice (last 90 days)</label>
          {!customerId ? (
            <div className="text-xs text-surface-400 dark:text-surface-500 py-2">
              Pick a customer first
            </div>
          ) : invLoading ? (
            <div className="py-2"><Loader /></div>
          ) : !invoices || invoices.length === 0 ? (
            <div className="text-xs text-surface-500 dark:text-surface-400 py-2">
              No invoices in the last 90 days.
            </div>
          ) : (
            <Select
              value={chosenInvoiceId}
              onChange={(e) => { setChosenInvoiceId(e.target.value); setSelectedQtys({}); }}
              placeholder="Select invoice..."
              options={invoiceOptions}
            />
          )}
        </div>
      </div>

      {/* Row 2 — Per-line quantity grid (only when invoice chosen) */}
      {chosenInvoice && (
        <div className="border border-surface-200 dark:border-surface-700 rounded-lg p-3">
          <div className="text-xs font-medium text-surface-700 dark:text-surface-300 mb-2">
            Defective quantities (invoice: {chosenInvoice.invoiceNumber})
          </div>
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_100px_120px_120px] gap-2 text-xs text-surface-500 dark:text-surface-400 pb-1 border-b border-surface-200 dark:border-surface-700">
              <div>Cylinder</div>
              <div className="text-right">Rate</div>
              <div className="text-right">Defective qty</div>
              <div className="text-right">Line total</div>
            </div>
            {chosenInvoice.lines.map((line) => {
              const curr = selectedQtys[line.cylinderTypeId] ?? 0;
              return (
                <div key={line.invoiceItemId} className="grid grid-cols-[1fr_100px_120px_120px] gap-2 items-center text-sm">
                  <div>
                    <div className="font-medium text-surface-900 dark:text-surface-100">{line.cylinderTypeName}</div>
                    <div className="text-xs text-surface-500 dark:text-surface-400">
                      avail {line.remainingQty}/{line.qty}
                    </div>
                  </div>
                  <div className="text-right text-surface-700 dark:text-surface-300">
                    ₹{line.perCylRate.toLocaleString('en-IN')}
                  </div>
                  <Input
                    type="number"
                    min={0}
                    max={line.remainingQty}
                    value={curr}
                    onChange={(e) => {
                      const v = Math.max(0, Math.min(line.remainingQty, Number(e.target.value) || 0));
                      setSelectedQtys((prev) => ({ ...prev, [line.cylinderTypeId]: v }));
                    }}
                    disabled={line.remainingQty === 0}
                  />
                  <div className="text-right font-medium text-surface-900 dark:text-surface-100">
                    ₹{(curr * line.perCylRate).toLocaleString('en-IN')}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Row 3 — Date / Reason / Notes */}
      {chosenInvoice && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="label">Collected Date</label>
            <Input type="date" value={collectedDate} onChange={(e) => setCollectedDate(e.target.value)} max={localTodayISO()} />
          </div>
          <div>
            <label className="label">Reason (optional)</label>
            <Select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="— none —"
              options={[
                { value: 'Leaky valve', label: 'Leaky valve' },
                { value: 'Bad seal', label: 'Bad seal' },
                { value: 'Low weight', label: 'Low weight' },
                { value: 'Damaged body', label: 'Damaged body' },
                { value: 'Other', label: 'Other' },
              ]}
            />
          </div>
          <div>
            <label className="label">Notes (optional)</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Extra context..." />
          </div>
        </div>
      )}

      {/* Bottom bar — preview + submit */}
      {chosenInvoice && (
        <div className="bg-surface-100 dark:bg-surface-800 rounded-lg p-3 flex items-center justify-between border border-surface-200 dark:border-surface-700">
          <div>
            <div className="text-xs text-surface-500 dark:text-surface-400 uppercase tracking-wide">
              CN Preview
            </div>
            <div className="text-xl font-semibold text-surface-900 dark:text-surface-100">
              ₹{previewAmount.toLocaleString('en-IN')}
            </div>
          </div>
          <Button
            onClick={submit}
            disabled={!hasAnyQty || busy}
            loading={busy}
          >
            Record Defective Return &amp; Raise CN
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Tab 2 — History ────────────────────────────────────────────────────────

function DefectiveHistoryTab() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['defective-returns-history', statusFilter],
    queryFn: () => apiGet<DefectiveReturn[]>('/defective-returns', statusFilter ? { status: statusFilter } : undefined),
  });

  const raiseMut = useMutation({
    mutationFn: (drId: string) =>
      apiPost<{ creditNoteId: string; cnNumber: string; cnAmount: number }>(
        `/defective-returns/${drId}/raise-cn`,
        { defectiveIds: [drId], reason: 'Defective cylinder return' },
      ),
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: ['defective-returns-history'] });
      queryClient.invalidateQueries({ queryKey: ['defective-returns-pending-count'] });
      queryClient.invalidateQueries({ queryKey: ['defective-depot-bucket'] });
      toast.success(`CN ${d.cnNumber} raised for ₹${d.cnAmount.toLocaleString('en-IN')}`);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const cancelMut = useMutation({
    mutationFn: (drId: string) => apiPost(`/defective-returns/${drId}/cancel`, { reason: 'Cancelled from History tab' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['defective-returns-history'] });
      queryClient.invalidateQueries({ queryKey: ['defective-returns-pending-count'] });
      toast.success('Cancelled — customer balance restored');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-surface-500 dark:text-surface-400">
          {data ? `${data.length} row${data.length === 1 ? '' : 's'}` : ''}
        </div>
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          placeholder="All statuses"
          className="w-52"
          options={[
            { value: 'collected', label: 'CN pending' },
            { value: 'cn_issued', label: 'CN issued' },
            { value: 'sent_to_corporation', label: 'Sent to corp' },
            { value: 'corporation_credit_received', label: 'Corp credit rec.' },
            { value: 'cancelled', label: 'Cancelled' },
          ]}
        />
      </div>
      {isLoading && <div className="text-center py-6"><Loader /></div>}
      {!isLoading && (!data || data.length === 0) && (
        <EmptyState title="No defective returns yet" description="Recorded returns will appear here." />
      )}
      {!isLoading && data && data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-200 dark:border-surface-700 text-left text-xs text-surface-500 dark:text-surface-400 uppercase">
                <th className="py-2 pr-3">Date</th>
                <th className="py-2 pr-3">Customer</th>
                <th className="py-2 pr-3">Src Inv</th>
                <th className="py-2 pr-3">Cyl</th>
                <th className="py-2 pr-3 text-right">Qty</th>
                <th className="py-2 pr-3">CN #</th>
                <th className="py-2 pr-3 text-right">CN Amt</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => {
                const isBusy =
                  (raiseMut.isPending && raiseMut.variables === row.id) ||
                  (cancelMut.isPending && cancelMut.variables === row.id);
                return (
                  <tr key={row.id} className="border-b border-surface-100 dark:border-surface-800/50">
                    <td className="py-2 pr-3">{row.collectedDate}</td>
                    <td className="py-2 pr-3 font-medium">{row.customerName}</td>
                    <td className="py-2 pr-3">{row.sourceInvoiceNumber ?? '—'}</td>
                    <td className="py-2 pr-3">{row.cylinderTypeName}</td>
                    <td className="py-2 pr-3 text-right font-medium">{row.quantity}</td>
                    <td className="py-2 pr-3">{row.creditNoteNumber ?? '—'}</td>
                    <td className="py-2 pr-3 text-right">₹{row.cnAmount.toLocaleString('en-IN')}</td>
                    <td className="py-2 pr-3"><DrStatusBadge status={row.status} /></td>
                    <td className="py-2 pr-3">
                      {row.status === 'collected' ? (
                        <div className="flex gap-1">
                          <button
                            type="button"
                            className="text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                            onClick={() => {
                              if (window.confirm(`Raise CN of ₹${row.cnAmount.toLocaleString('en-IN')} for ${row.customerName}?`)) {
                                raiseMut.mutate(row.id);
                              }
                            }}
                            disabled={isBusy}
                          >
                            Raise CN
                          </button>
                          <button
                            type="button"
                            className="text-xs px-2 py-1 rounded border border-surface-300 dark:border-surface-600 hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-50"
                            onClick={() => {
                              if (window.confirm(`Cancel this defective row? Customer's ${row.cylinderTypeName} holding will be restored.`)) {
                                cancelMut.mutate(row.id);
                              }
                            }}
                            disabled={isBusy}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-surface-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DrStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    collected: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    cn_issued: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    sent_to_corporation: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
    corporation_credit_received: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    cancelled: 'bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-400',
  };
  const label: Record<string, string> = {
    collected: 'CN pending',
    cn_issued: 'CN issued',
    sent_to_corporation: 'Sent to corp',
    corporation_credit_received: 'Corp credit rec.',
    cancelled: 'Cancelled',
  };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${styles[status] ?? styles.collected}`}>
      {label[status] ?? status}
    </span>
  );
}

// F1-FIX-11 (2026-08-06) — DefectiveSendTab component REMOVED. Shipping
// defective back to corp now piggybacks on the Record Outgoing Empties
// modal (see the "Include defective fulls" section there). Suneel spec:
// "dont need send to corp".

