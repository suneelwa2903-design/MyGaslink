import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';

/**
 * Reports service — powers GET /api/reports/:reportType (TASK 1).
 *
 * Each report returns a consistent envelope so the web Reports page and the
 * CSV exporter can render any report generically:
 *   { columns: {key,label}[], rows: Record<string,any>[], totals?, chart? }
 *
 * All queries are tenant-scoped by distributorId. Money fields are converted
 * to plain numbers (Prisma Decimal -> number) at the service boundary.
 */

export interface ReportColumn { key: string; label: string; money?: boolean; }
export type ReportLineChartPoint = { x: string; y: number };
export interface ReportBarChartData {
  labels: string[];
  series: { name: string; values: number[] }[];
}
export type ReportChartData = ReportLineChartPoint[] | ReportBarChartData;
export interface ReportChart {
  type: 'line' | 'bar';
  title: string;
  // line: [{ x, y }]; bar(stacked): { labels:[], series:[{ name, values:[] }] }
  data: ReportChartData;
}
export interface ReportTable {
  title: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals?: Record<string, unknown>;
}
export interface ReportResult {
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals?: Record<string, unknown>;
  chart?: ReportChart;
  // Optional secondary table rendered above the main grid (e.g. the
  // depot-level Corporation loads table in the Vehicle Ledger report).
  secondary?: ReportTable;
}

export interface ReportFilters {
  dateFrom?: string;
  dateTo?: string;
  // 2026-07-17: Payment Collections entry-date filter — narrows to
  // payments whose PaymentTransaction.createdAt falls in the range.
  // Stacks with dateFrom/dateTo (which target transactionDate). Only
  // paymentCollections consumes these today; other reports ignore.
  entryDateFrom?: string;
  entryDateTo?: string;
  customerId?: string;
  // Feature A (2026-07-15): optional customer-id list for the HQ
  // group portal — narrows outstandingAging to a set of customers
  // (a CustomerGroup's members) instead of the full distributor.
  // When both `customerId` and `customerIds` are provided, `customerId`
  // wins (single-property drill-down from the group view).
  customerIds?: string[];
  cylinderTypeId?: string;
  driverId?: string;
  vehicleId?: string;
  groupBy?: 'trip' | 'day' | 'customer' | 'invoice';
  // INVESTIGATION-JUL09 followup — delivery-performance CSV export request:
  // when true, append per-customer breakdown rows under each driver's
  // cylinder rows in the same rows array. Default false to keep the JSON
  // top-level view compact.
  includeCustomers?: boolean;
  // Driver Statement filter — client-side status chip. Passed through so
  // the CSV / PDF export honours the same filter the user is looking at.
  statusFilter?: 'all' | 'paid' | 'partial' | 'pending' | 'overdue';
  // 2026-08-06 — N18 Customer Profitability: interest-rate input on top of
  // the report (editable per-run per Suneel — "rate differs from time to
  // time"). Applied to (a) AR outstanding × days/365 → AR Cost, (b) empty
  // deposit float × days/365 → Empty Deposit Cost. Defaults to 12 (typical
  // Indian SME lending rate); UI persists last-used value per-user in
  // localStorage.
  arInterestRatePct?: number;
  // F8v2-R (2026-08-06) — Corporation-bucket reports filter to one OMC
  // supplier. Optional; omit for tenant-wide view (all corps aggregated).
  sourceDistributorId?: string;
}

// ─── Invoice status helper ────────────────────────────────────────────────
//
// Single source of truth for the four operational status buckets shown in
// the Driver Statement modal + PDF and any future collections view. The
// priority order matters:
//   1. Paid    — outstanding cleared (regardless of due date)
//   2. Overdue — past due AND anything still outstanding (takes priority
//                over Partial so overdue-partial invoices are actionable)
//   3. Partial — some money received, not overdue
//   4. Pending — nothing received, not overdue
// Cancelled / opening-balance / non-issued statuses degrade to Pending so
// the caller can filter them out separately if needed.
export type InvoiceStatus = 'Paid' | 'Partial' | 'Pending' | 'Overdue';

export function invoiceStatus(
  invoice: {
    totalAmount: number | { toString: () => string };
    amountPaid: number | { toString: () => string };
    outstandingAmount: number | { toString: () => string };
    dueDate: Date | string | null;
    // Item-8 (2026-07-09): pass BOTH issueDate + creditPeriodDays to derive
    // the "Overdue" cutoff live from the customer's current credit period
    // (bypassing the frozen invoice.dueDate snapshot). If either is omitted
    // the function falls back to the stored dueDate — this keeps existing
    // callers (including driver-statement.test.ts) working unchanged. See
    // docs/INVESTIGATION-JUL09-B.md item 8.
    issueDate?: Date | string | null;
    creditPeriodDays?: number | null;
  },
  today: Date = (() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  })(),
): InvoiceStatus {
  const outstanding = num(invoice.outstandingAmount);
  const paid = num(invoice.amountPaid);
  if (outstanding <= 0) return 'Paid';
  const derivedDue = invoice.issueDate && invoice.creditPeriodDays != null
    ? new Date(new Date(invoice.issueDate).getTime() + invoice.creditPeriodDays * 86_400_000)
    : (invoice.dueDate ? new Date(invoice.dueDate) : null);
  if (derivedDue && derivedDue < today) return 'Overdue';
  if (paid > 0) return 'Partial';
  return 'Pending';
}

const num = (d: unknown): number => (d == null ? 0 : Number(d));
function range(filters: ReportFilters) {
  const from = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00.000Z`) : new Date('2000-01-01T00:00:00.000Z');
  const to = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59.999Z`) : new Date('2999-12-31T23:59:59.999Z');
  return { from, to };
}
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

// ─── Report 1 — Sales Summary ────────────────────────────────────────────────
export async function salesSummary(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      status: { in: ['delivered', 'modified_delivered'] },
      deliveryDate: { gte: from, lte: to },
      deletedAt: null,
      ...(f.cylinderTypeId ? { items: { some: { cylinderTypeId: f.cylinderTypeId } } } : {}),
    },
    include: { items: true, customer: { select: { customerName: true } } },
  });

  // Per-customer table
  const byCust = new Map<string, { customer: string; orders: number; qtyDelivered: number; revenue: number }>();
  // Per-day series for the chart
  const byDay = new Map<string, number>();
  for (const o of orders) {
    const cname = o.customer?.customerName ?? 'Unknown';
    const qty = o.items
      .filter((it) => !f.cylinderTypeId || it.cylinderTypeId === f.cylinderTypeId)
      .reduce((s, it) => s + (it.deliveredQuantity ?? it.quantity), 0);
    const rev = num(o.totalAmount);
    const cur = byCust.get(o.customerId) ?? { customer: cname, orders: 0, qtyDelivered: 0, revenue: 0 };
    cur.orders += 1; cur.qtyDelivered += qty; cur.revenue += rev;
    byCust.set(o.customerId, cur);
    const dk = dayKey(o.deliveryDate);
    byDay.set(dk, (byDay.get(dk) ?? 0) + rev);
  }
  const rows = [...byCust.values()].sort((a, b) => b.revenue - a.revenue);
  const totals = {
    customer: 'TOTAL',
    orders: rows.reduce((s, r) => s + r.orders, 0),
    qtyDelivered: rows.reduce((s, r) => s + r.qtyDelivered, 0),
    revenue: rows.reduce((s, r) => s + r.revenue, 0),
  };
  const chartData = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([x, y]) => ({ x, y }));
  return {
    columns: [
      { key: 'customer', label: 'Customer' },
      { key: 'orders', label: 'Orders' },
      { key: 'qtyDelivered', label: 'Qty Delivered' },
      { key: 'revenue', label: 'Revenue', money: true },
    ],
    rows, totals,
    chart: { type: 'line', title: 'Daily Revenue', data: chartData },
  };
}

// ─── Report — Daily Sales (Chunk 2 · 2026-08-05) ────────────────────────
//
// Same underlying delivered-orders + payments data as Sales Summary, but
// rolled up per DAY instead of per customer. Reads like a running day-by-
// day operational log — the natural companion to Day-Close Summary
// (single-day snapshot) when you want a Mon-Fri or full-month view.
//
// Row shape: one row per day WITH activity in the range. Days with zero
// activity are omitted (keeps output tight; if the operator wants a
// calendar view with gaps they can query a single-day range).
//
// Filter behavior: dateFrom + dateTo. Optional cylinderTypeId scopes the
// delivered qty to that specific cylinder (payments are NOT filtered by
// cyl type — payments cover invoices which span multiple cyl types).
export async function dailySales(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const fromStr = dayKey(from);
  const toStr = dayKey(to);

  // 2026-08-06: enriched columns per Suneel — Cyl mix (e.g. "5×19KG,
  // 3×47.5KG"), Empties Collected (from collection inventory events),
  // Expenses (from expense table, by expense_date string). All four sources
  // fetched in parallel.
  const [orders, paymentsGrouped, emptiesEvents, expenses, cylTypes] = await Promise.all([
    prisma.order.findMany({
      where: {
        distributorId,
        status: { in: ['delivered', 'modified_delivered'] },
        deliveryDate: { gte: from, lte: to },
        deletedAt: null,
        ...(f.cylinderTypeId ? { items: { some: { cylinderTypeId: f.cylinderTypeId } } } : {}),
      },
      include: { items: true },
    }),
    prisma.paymentTransaction.groupBy({
      by: ['transactionDate'],
      where: { distributorId, transactionDate: { gte: from, lte: to } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.inventoryEvent.findMany({
      where: {
        distributorId,
        eventDate: { gte: from, lte: to },
        eventType: { in: ['collection', 'returns_collection'] },
      },
      select: { eventDate: true, emptiesChange: true },
    }),
    prisma.expense.groupBy({
      by: ['expenseDate'],
      where: { distributorId, expenseDate: { gte: fromStr, lte: toStr }, deletedAt: null },
      _sum: { amount: true },
    }),
    prisma.cylinderType.findMany({
      where: { distributorId, isActive: true },
      select: { id: true, typeName: true },
    }),
  ]);
  const cylNameById = new Map(cylTypes.map((c) => [c.id, c.typeName]));

  // Aggregate orders per-day. cylMixByType is Map<cylTypeId, qty>.
  type DayRow = { date: string; orders: number; qtyDelivered: number; cylMix: string; empties: number; revenue: number; paymentsReceived: number; paymentsCount: number; expenses: number };
  interface DayInternal { date: string; orders: number; qtyDelivered: number; cylMixByType: Map<string, number>; empties: number; revenue: number; paymentsReceived: number; paymentsCount: number; expenses: number }
  const perDay = new Map<string, DayInternal>();
  const getOrInit = (dk: string): DayInternal => {
    const existing = perDay.get(dk);
    if (existing) return existing;
    const fresh: DayInternal = { date: dk, orders: 0, qtyDelivered: 0, cylMixByType: new Map(), empties: 0, revenue: 0, paymentsReceived: 0, paymentsCount: 0, expenses: 0 };
    perDay.set(dk, fresh);
    return fresh;
  };
  for (const o of orders) {
    const dk = dayKey(o.deliveryDate);
    const row = getOrInit(dk);
    row.orders += 1;
    row.revenue += num(o.totalAmount);
    for (const it of o.items) {
      if (f.cylinderTypeId && it.cylinderTypeId !== f.cylinderTypeId) continue;
      const qty = it.deliveredQuantity ?? it.quantity;
      row.qtyDelivered += qty;
      row.cylMixByType.set(it.cylinderTypeId, (row.cylMixByType.get(it.cylinderTypeId) ?? 0) + qty);
    }
  }
  for (const p of paymentsGrouped) {
    const dk = dayKey(p.transactionDate);
    const row = getOrInit(dk);
    row.paymentsReceived += num(p._sum.amount);
    row.paymentsCount += p._count;
  }
  for (const e of emptiesEvents) {
    const dk = dayKey(e.eventDate);
    const row = getOrInit(dk);
    row.empties += Math.abs(e.emptiesChange);
  }
  for (const e of expenses) {
    const row = getOrInit(e.expenseDate); // already 'YYYY-MM-DD'
    row.expenses += num(e._sum.amount);
  }

  const rows: DayRow[] = [...perDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({
      date: r.date,
      orders: r.orders,
      qtyDelivered: r.qtyDelivered,
      // Cyl mix — sorted by qty desc, joined "5×19KG, 3×47.5KG" (max 4 types
      // shown to keep cells compact).
      cylMix: [...r.cylMixByType.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, 4)
        .map(([id, qty]) => `${qty}×${cylNameById.get(id) ?? '?'}`)
        .join(', ') || '—',
      empties: r.empties,
      revenue: r.revenue,
      paymentsReceived: r.paymentsReceived,
      paymentsCount: r.paymentsCount,
      expenses: r.expenses,
    }));

  const totals = {
    date: 'TOTAL',
    orders: rows.reduce((s, r) => s + r.orders, 0),
    qtyDelivered: rows.reduce((s, r) => s + r.qtyDelivered, 0),
    cylMix: '',
    empties: rows.reduce((s, r) => s + r.empties, 0),
    revenue: rows.reduce((s, r) => s + r.revenue, 0),
    paymentsReceived: rows.reduce((s, r) => s + r.paymentsReceived, 0),
    paymentsCount: rows.reduce((s, r) => s + r.paymentsCount, 0),
    expenses: rows.reduce((s, r) => s + r.expenses, 0),
  };

  return {
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'orders', label: 'Orders' },
      { key: 'qtyDelivered', label: 'Fulls Delivered' },
      { key: 'cylMix', label: 'Cyl Mix' },
      { key: 'empties', label: 'Empties Collected' },
      { key: 'revenue', label: 'Revenue', money: true },
      { key: 'paymentsReceived', label: 'Payments Received', money: true },
      { key: 'paymentsCount', label: 'Pmt Count' },
      { key: 'expenses', label: 'Expenses', money: true },
    ],
    rows,
    totals,
    chart: {
      type: 'line',
      title: 'Daily Revenue',
      data: rows.map((r) => ({ x: r.date, y: r.revenue })),
    },
  };
}

// ─── Report — Driver Daily Log (2026-08-06 merger of Chunk 2 · Daily
//                Driver Movement + Chunk 4 · Route / Driver Performance)
//
// One row per (date × driver) — the "what did each driver do each day"
// answer. Replaces both DailyDriverMovement (per-day counts) and
// RouteDriverPerformance (efficiency ratios) — they were 60% overlapping
// so a single report with all columns is cleaner.
//
// The response includes TWO row types in one flat array:
//   type='driver_day' — parent row per (date, driver) aggregate
//   type='trip'       — child row per (date, driver, tripNumber) — the
//                       chevron-expand children in the UI
// Child rows for a (date, driver) group live IMMEDIATELY AFTER their
// parent row so the UI's DriverDailyLogTable can hide/show them by index.
// Matches the two-row-type pattern used by Delivery Performance
// (driver_summary + cylinder_row).
//
// Columns (same for parent and child, though `date` on child rows echoes
// the parent's date so CSV export is complete):
//   Date | Driver | Trip | Deliveries | Fulls Delivered | Empties
//   Collected | Revenue | On-Time % | Cancel %
//
// Filter behavior: dateFrom + dateTo, optional driverId to narrow to
// one driver. Cylinder-type filter NOT supported — this is a driver-
// productivity view, not a per-cylinder view.
export async function driverDailyLog(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);

  let driverIdFilter: string | undefined;
  if (f.driverId) driverIdFilter = f.driverId;

  // Load delivered + cancelled orders — need cancelled for the cancel-rate
  // column that RouteDriverPerformance provided.
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      status: { in: ['delivered', 'modified_delivered', 'cancelled'] },
      deliveryDate: { gte: from, lte: to },
      deletedAt: null,
      driverId: { not: null },
      ...(driverIdFilter ? { driverId: driverIdFilter } : {}),
    },
    include: {
      items: { select: { deliveredQuantity: true, quantity: true, emptiesCollected: true } },
      driver: { select: { driverName: true } },
    },
  });

  // Delivery proofs for on-time % calculation. Same rule as
  // RouteDriverPerformance: on-time if capturedAt.dayKey <= deliveryDate.dayKey.
  const orderIds = orders.map((o) => o.id);
  const proofs = orderIds.length
    ? await prisma.deliveryProof.findMany({
        where: { distributorId, orderId: { in: orderIds } },
        select: { orderId: true, capturedAt: true },
      })
    : [];
  const proofByOrder = new Map<string, Date>(proofs.map((p) => [p.orderId, p.capturedAt]));

  // Aggregate per (dayKey, driverId, tripBucket) at TRIP level first,
  // then roll up to (dayKey, driverId) for the driver-day parent rows.
  // Trip bucket: use Order.tripNumber when set; fall back to a synthetic
  // per-order bucket for orders with no trip (matches Vehicle Ledger's
  // `?? 'na'` semantics but keeps them separate so the trip count
  // doesn't collapse everything into "na"). Per user's Aug 2026 fix,
  // backdated orders with driver+vehicle now stamp tripNumber, so 'na'
  // is only for godown/mini-op paths — those get excluded here by the
  // `driverId: { not: null }` filter above.
  interface TripAgg {
    date: string;
    driverId: string;
    driverName: string;
    tripKey: string; // 'trip:N' or 'orphan:orderId'
    tripLabel: string; // 'Trip 1' / 'Trip 2' / 'No trip' — display value
    tripNumber: number | null; // real trip number or null for orphan
    orders: number;
    deliveries: number;
    cancelled: number;
    fullsDelivered: number;
    emptiesCollected: number;
    revenue: number;
    onTime: number;
    late: number;
  }
  const per = new Map<string, TripAgg>();
  const bucketKey = (dk: string, drvId: string, tripKey: string) => `${dk}|${drvId}|${tripKey}`;

  for (const o of orders) {
    if (!o.driverId) continue;
    const dk = dayKey(o.deliveryDate);
    const tripNum = o.tripNumber ?? null;
    const tripKey = tripNum !== null ? `trip:${tripNum}` : `orphan:${o.id}`;
    const tripLabel = tripNum !== null ? `Trip ${tripNum}` : 'No trip';
    const k = bucketKey(dk, o.driverId, tripKey);
    const row = per.get(k) ?? {
      date: dk,
      driverId: o.driverId,
      driverName: o.driver?.driverName ?? '—',
      tripKey,
      tripLabel,
      tripNumber: tripNum,
      orders: 0,
      deliveries: 0,
      cancelled: 0,
      fullsDelivered: 0,
      emptiesCollected: 0,
      revenue: 0,
      onTime: 0,
      late: 0,
    };
    row.orders += 1;
    if (o.status === 'delivered' || o.status === 'modified_delivered') {
      row.deliveries += 1;
      row.revenue += num(o.totalAmount);
      row.fullsDelivered += o.items.reduce((s, it) => s + (it.deliveredQuantity ?? it.quantity), 0);
      row.emptiesCollected += o.items.reduce((s, it) => s + (it.emptiesCollected ?? 0), 0);
      const proof = proofByOrder.get(o.id);
      if (proof) {
        const scheduledStr = dayKey(o.deliveryDate);
        const actualStr = dayKey(proof);
        if (actualStr <= scheduledStr) row.onTime += 1;
        else row.late += 1;
      }
    } else if (o.status === 'cancelled') {
      row.cancelled += 1;
    }
    per.set(k, row);
  }

  // Roll trip-level rows up to driver-day parent rows.
  interface ParentAgg {
    date: string;
    driverId: string;
    driverName: string;
    trips: number;
    deliveries: number;
    cancelled: number;
    fullsDelivered: number;
    emptiesCollected: number;
    revenue: number;
    onTime: number;
    late: number;
  }
  const parentMap = new Map<string, ParentAgg>();
  for (const t of per.values()) {
    const pk = `${t.date}|${t.driverId}`;
    const parent = parentMap.get(pk) ?? {
      date: t.date,
      driverId: t.driverId,
      driverName: t.driverName,
      trips: 0,
      deliveries: 0,
      cancelled: 0,
      fullsDelivered: 0,
      emptiesCollected: 0,
      revenue: 0,
      onTime: 0,
      late: 0,
    };
    parent.trips += 1;
    parent.deliveries += t.deliveries;
    parent.cancelled += t.cancelled;
    parent.fullsDelivered += t.fullsDelivered;
    parent.emptiesCollected += t.emptiesCollected;
    parent.revenue += t.revenue;
    parent.onTime += t.onTime;
    parent.late += t.late;
    parentMap.set(pk, parent);
  }

  // Build the flat rows[] with parent-then-children ordering. Sort parents
  // by (date asc, driver name asc); trip children under each parent sort
  // by tripNumber asc, orphan trips last.
  const rows: Record<string, string | number | null>[] = [];
  const parents = [...parentMap.values()].sort((a, b) =>
    a.date === b.date ? a.driverName.localeCompare(b.driverName) : a.date.localeCompare(b.date),
  );
  for (const p of parents) {
    const onTimeDenom = p.onTime + p.late;
    const cancelDenom = p.deliveries + p.cancelled;
    rows.push({
      type: 'driver_day',
      date: p.date,
      driverId: p.driverId,
      driverName: p.driverName,
      trip: '', // parent row — no trip label
      trips: p.trips,
      deliveries: p.deliveries,
      cancelled: p.cancelled,
      fullsDelivered: p.fullsDelivered,
      emptiesCollected: p.emptiesCollected,
      revenue: p.revenue,
      onTimeRate: onTimeDenom > 0 ? Math.round((p.onTime / onTimeDenom) * 100) : 0,
      cancelRate: cancelDenom > 0 ? Math.round((p.cancelled / cancelDenom) * 100) : 0,
    });
    // Child rows for this parent — filter + sort.
    const children = [...per.values()]
      .filter((t) => t.date === p.date && t.driverId === p.driverId)
      .sort((a, b) => {
        // Real trips before orphan, then by tripNumber ascending.
        if (a.tripNumber === null && b.tripNumber === null) return 0;
        if (a.tripNumber === null) return 1;
        if (b.tripNumber === null) return -1;
        return a.tripNumber - b.tripNumber;
      });
    for (const t of children) {
      const tOnTimeDenom = t.onTime + t.late;
      const tCancelDenom = t.deliveries + t.cancelled;
      rows.push({
        type: 'trip',
        date: t.date,
        driverId: t.driverId, // used by client to hide/show under parent
        driverName: '', // blank on child rows (visual indent)
        trip: t.tripLabel,
        trips: '', // count column doesn't apply on child
        deliveries: t.deliveries,
        cancelled: t.cancelled,
        fullsDelivered: t.fullsDelivered,
        emptiesCollected: t.emptiesCollected,
        revenue: t.revenue,
        onTimeRate: tOnTimeDenom > 0 ? Math.round((t.onTime / tOnTimeDenom) * 100) : '',
        cancelRate: tCancelDenom > 0 ? Math.round((t.cancelled / tCancelDenom) * 100) : '',
      });
    }
  }

  const totalOnTime = parents.reduce((s, p) => s + p.onTime, 0);
  const totalLate = parents.reduce((s, p) => s + p.late, 0);
  const totalDeliveries = parents.reduce((s, p) => s + p.deliveries, 0);
  const totalCancelled = parents.reduce((s, p) => s + p.cancelled, 0);
  const totalOnTimeDenom = totalOnTime + totalLate;
  const totalCancelDenom = totalDeliveries + totalCancelled;

  const totals = {
    type: '',
    date: 'TOTAL',
    driverName: '',
    driverId: '',
    trip: '',
    trips: parents.reduce((s, p) => s + p.trips, 0),
    deliveries: totalDeliveries,
    cancelled: totalCancelled,
    fullsDelivered: parents.reduce((s, p) => s + p.fullsDelivered, 0),
    emptiesCollected: parents.reduce((s, p) => s + p.emptiesCollected, 0),
    revenue: parents.reduce((s, p) => s + p.revenue, 0),
    onTimeRate: totalOnTimeDenom > 0 ? Math.round((totalOnTime / totalOnTimeDenom) * 100) : 0,
    cancelRate: totalCancelDenom > 0 ? Math.round((totalCancelled / totalCancelDenom) * 100) : 0,
  };

  return {
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'driverName', label: 'Driver' },
      { key: 'trip', label: 'Trip' },
      { key: 'trips', label: '# Trips' },
      { key: 'deliveries', label: 'Deliveries' },
      { key: 'cancelled', label: 'Cancelled' },
      { key: 'fullsDelivered', label: 'Fulls Delivered' },
      { key: 'emptiesCollected', label: 'Empties Collected' },
      { key: 'revenue', label: 'Revenue', money: true },
      { key: 'onTimeRate', label: 'On-Time %' },
      { key: 'cancelRate', label: 'Cancel %' },
    ],
    rows,
    totals,
  };
}

// ─── Report 2 — Outstanding & Aging ──────────────────────────────────────────
//
// Group 5 (2026-06-11): the dateFrom/dateTo filter is now honoured (was
// `_f` and silently ignored — confirmed empirically in K9). The window
// applies to `issueDate` (when the invoice was created), so pre-go-live
// opening-balance invoices are correctly excluded by default if a
// distributor passes `dateFrom = goLiveDate`. The route layer fills
// dateFrom from distributor.goLiveDate when the caller didn't supply one.
export async function outstandingAging(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const dateFrom = f?.dateFrom ? new Date(f.dateFrom) : null;
  const dateTo = f?.dateTo ? new Date(f.dateTo) : null;
  const invoiceWhere: Prisma.InvoiceWhereInput = {
    distributorId,
    outstandingAmount: { gt: 0 },
    deletedAt: null,
    status: { not: 'cancelled' },
  };
  if (dateFrom || dateTo) {
    invoiceWhere.issueDate = {};
    if (dateFrom) (invoiceWhere.issueDate as Prisma.DateTimeFilter).gte = dateFrom;
    if (dateTo) (invoiceWhere.issueDate as Prisma.DateTimeFilter).lte = dateTo;
  }
  // Feature A (2026-07-15): HQ group portal filter. A single customer
  // narrow overrides the group list (single-property drill-down from
  // the group aging view). When both are absent the report stays
  // distributor-wide as before.
  if (f?.customerId) {
    invoiceWhere.customerId = f.customerId;
  } else if (f?.customerIds && f.customerIds.length > 0) {
    invoiceWhere.customerId = { in: f.customerIds };
  }
  const invoices = await prisma.invoice.findMany({
    where: invoiceWhere,
    // Item-8 fix: read `issueDate` and pull `customer.creditPeriodDays` so
    // the aging buckets derive live from the current credit period, not the
    // frozen `invoice.dueDate` snapshot. See docs/INVESTIGATION-JUL09-B.md
    // item 8.
    select: {
      customerId: true,
      outstandingAmount: true,
      issueDate: true,
      customer: { select: { customerName: true, creditPeriodDays: true } },
    },
  });
  const lastPayments = await prisma.paymentTransaction.groupBy({
    by: ['customerId'],
    where: { distributorId, deletedAt: null },
    _max: { transactionDate: true },
  });
  const lastPayMap = new Map(lastPayments.map((p) => [p.customerId, p._max.transactionDate]));

  const now = new Date();
  const nowMs = now.getTime();
  const byCust = new Map<string, { customer: string; total: number; b0_30: number; b31_60: number; b60plus: number; lastPayment: string; _overdue: boolean }>();
  for (const inv of invoices) {
    if (!inv.customerId) continue;
    const amt = num(inv.outstandingAmount);
    const creditPeriodDays = inv.customer?.creditPeriodDays ?? 30;
    const derivedDueMs = new Date(inv.issueDate).getTime() + creditPeriodDays * 86_400_000;
    const daysOverdue = Math.floor((nowMs - derivedDueMs) / 86_400_000);
    const cur = byCust.get(inv.customerId) ?? { customer: inv.customer?.customerName ?? 'Unknown', total: 0, b0_30: 0, b31_60: 0, b60plus: 0, lastPayment: '', _overdue: false };
    cur.total += amt;
    if (daysOverdue <= 30) cur.b0_30 += amt;
    else if (daysOverdue <= 60) { cur.b31_60 += amt; cur._overdue = true; }
    else { cur.b60plus += amt; cur._overdue = true; }
    const lp = lastPayMap.get(inv.customerId);
    cur.lastPayment = lp ? dayKey(new Date(lp)) : '—';
    byCust.set(inv.customerId, cur);
  }
  const rows = [...byCust.values()].sort((a, b) => b.total - a.total);
  const totals = {
    customer: 'TOTAL', total: rows.reduce((s, r) => s + r.total, 0),
    b0_30: rows.reduce((s, r) => s + r.b0_30, 0), b31_60: rows.reduce((s, r) => s + r.b31_60, 0),
    b60plus: rows.reduce((s, r) => s + r.b60plus, 0), lastPayment: '',
  };
  return {
    columns: [
      { key: 'customer', label: 'Customer' },
      { key: 'total', label: 'Total Outstanding', money: true },
      { key: 'b0_30', label: '0-30 days', money: true },
      { key: 'b31_60', label: '31-60 days', money: true },
      { key: 'b60plus', label: '60+ days', money: true },
      { key: 'lastPayment', label: 'Last Payment' },
    ],
    rows, totals,
  };
}

// ─── Report 3 — GST Summary ──────────────────────────────────────────────────
export async function gstSummary(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const invoices = await prisma.invoice.findMany({
    where: { distributorId, issueDate: { gte: from, lte: to }, deletedAt: null, status: { not: 'cancelled' } },
    select: { invoiceNumber: true, issueDate: true, totalAmount: true, cgstValue: true, sgstValue: true, igstValue: true, customer: { select: { customerName: true } } },
    orderBy: { issueDate: 'asc' },
  });
  const rows = invoices.map((inv) => {
    const cgst = num(inv.cgstValue), sgst = num(inv.sgstValue), igst = num(inv.igstValue), total = num(inv.totalAmount);
    return {
      invoiceNumber: inv.invoiceNumber,
      customer: inv.customer?.customerName ?? 'Unknown',
      date: dayKey(new Date(inv.issueDate)),
      taxable: +(total - cgst - sgst - igst).toFixed(2),
      cgst, sgst, igst, total,
    };
  });
  const totals = {
    invoiceNumber: 'TOTAL', customer: '', date: '',
    taxable: +rows.reduce((s, r) => s + r.taxable, 0).toFixed(2),
    cgst: +rows.reduce((s, r) => s + r.cgst, 0).toFixed(2),
    sgst: +rows.reduce((s, r) => s + r.sgst, 0).toFixed(2),
    igst: +rows.reduce((s, r) => s + r.igst, 0).toFixed(2),
    total: +rows.reduce((s, r) => s + r.total, 0).toFixed(2),
  };
  return {
    columns: [
      { key: 'invoiceNumber', label: 'Invoice No' }, { key: 'customer', label: 'Customer' },
      { key: 'date', label: 'Date' }, { key: 'taxable', label: 'Taxable Value', money: true },
      { key: 'cgst', label: 'CGST', money: true }, { key: 'sgst', label: 'SGST', money: true },
      { key: 'igst', label: 'IGST', money: true }, { key: 'total', label: 'Total', money: true },
    ],
    rows, totals,
  };
}

// ─── Report 4 — Delivery Performance ─────────────────────────────────────────
//
// INVESTIGATION-JUL09: enhanced from a status-count table into a per-driver
// operational + financial snapshot with a customer drill-down.
//
// Row shapes (all in the same `rows` array — differentiated by `type`):
//   • driver_summary — one per driver in range. Aggregates fulls+empties
//     across all cylinder types plus the driver's money numbers (sale,
//     collected, pending, overdue).
//   • cylinder_row   — one per (driver, cylinderType). Fulls delivered +
//     empties collected only. NO money columns to avoid double-counting an
//     order that spans multiple cylinder types. Rendered indented under
//     the driver summary in the web UI.
//   • customer_row   — only in the drill-down (?groupBy=customer&driverId=X).
//     Per (customer, cylinderType) breakdown of this driver's deliveries,
//     PLUS a `pendingEmpties` column showing the customer's CUMULATIVE
//     pending empties for that cylinder type (per-customer, ACROSS ALL
//     drivers — the app doesn't ledger empties per driver).
//
// Money attribution:
//   • saleAmount    = sum(orders.totalAmount) for driver's in-range orders
//   • amountCollected = sum(paymentAllocations.allocatedAmount) for
//     invoices linked to those in-range orders (attribution follows the
//     delivery, not the payment date — matches Sale semantics).
//   • amountPending = sum(invoices.outstandingAmount) for those invoices
//   • amountOverdue = same but where dueDate < today
//
// Sections included in the driver report:
//   • Real drivers with delivered/modified_delivered orders in range
//   • Synthetic "Godown Pickup (self-collection)" bucket — collapses every
//     godown-pickup order (driverId=null, isGodownPickup=true) into ONE row
//     with driverId='godown_pickup' so the same driver-row renderer + drill-
//     down modal on the web handle them without a second component. Same
//     shape as any driver row (cyl breakdown, sale, collected, pending,
//     overdue). Drill-down groups by customer per the standard driver path.
//
// Excluded:
//   • status='cancelled' orders (not delivered) — invisible in every path.
export const GODOWN_PICKUP_DRIVER_ID = 'godown_pickup';
export const GODOWN_PICKUP_DRIVER_NAME = 'Godown Pickup (self-collection)';

export async function deliveryPerformance(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Drill-down branch: caller wants per-customer rows for a specific driver
  // (including the synthetic godown-pickup bucket).
  if (f.groupBy === 'customer' && f.driverId) {
    return deliveryPerformanceDrilldown(distributorId, f.driverId, from, to);
  }
  if (f.groupBy === 'invoice' && f.driverId) {
    return deliveryPerformanceStatement(distributorId, f.driverId, from, to, f.statusFilter ?? 'all');
  }

  // Step 1 — load all delivered/modified_delivered orders in range with
  // enough context (items, invoice) to compute both operational and financial
  // aggregates without a second round-trip. When driverId filter is unset we
  // include BOTH real-driver rows (isGodownPickup=false, driverId not null)
  // AND godown-pickup rows (isGodownPickup=true, driverId null) — they get
  // bucketed apart during aggregation via `isGodownPickup`. When the driverId
  // filter names the synthetic godown bucket, load ONLY godown orders. When
  // it names a real driver, load ONLY that driver's orders (godown excluded).
  const isGodownFilter = f.driverId === GODOWN_PICKUP_DRIVER_ID;
  const whereForOrders = {
    distributorId,
    status: { in: ['delivered', 'modified_delivered'] as ('delivered' | 'modified_delivered')[] },
    deliveryDate: { gte: from, lte: to },
    deletedAt: null,
    ...(isGodownFilter
      ? { isGodownPickup: true }
      : f.driverId
      ? { driverId: f.driverId, isGodownPickup: false }
      : {
          OR: [
            { driverId: { not: null }, isGodownPickup: false },
            { isGodownPickup: true },
          ],
        }),
  };
  const orders = await prisma.order.findMany({
    where: whereForOrders as unknown as Prisma.OrderWhereInput,
    select: {
      id: true,
      driverId: true,
      isGodownPickup: true,
      totalAmount: true,
      customerId: true,
      customer: { select: { customerName: true } },
      driver: { select: { driverName: true } },
      items: {
        select: {
          cylinderTypeId: true,
          quantity: true,
          deliveredQuantity: true,
          emptiesCollected: true,
          totalPrice: true,
          cylinderType: { select: { typeName: true } },
        },
      },
      invoice: {
        select: {
          id: true,
          outstandingAmount: true,
          dueDate: true,
          status: true,
        },
      },
    },
  });

  const invoiceIds = orders
    .map((o) => o.invoice?.id)
    .filter((v): v is string => Boolean(v));

  // Step 2 — payment allocations against those invoices. PaymentTransaction
  // has no driverId; attribution runs through invoice.order.driverId.
  const allocations = invoiceIds.length
    ? await prisma.paymentAllocation.findMany({
        where: { invoiceId: { in: invoiceIds } },
        select: {
          allocatedAmount: true,
          invoice: { select: { order: { select: { driverId: true, isGodownPickup: true } } } },
        },
      })
    : [];
  const collectedByDriver = new Map<string, number>();
  for (const a of allocations) {
    const order = a.invoice.order;
    if (!order) continue;
    // Godown pickups have driverId=null but MUST attribute money into the
    // synthetic bucket — otherwise the "Collected" cell on the Godown Pickup
    // row would always be ₹0 even when payments came in.
    const did = order.isGodownPickup ? GODOWN_PICKUP_DRIVER_ID : order.driverId;
    if (!did) continue;
    collectedByDriver.set(did, (collectedByDriver.get(did) ?? 0) + num(a.allocatedAmount));
  }

  // Step 3 — build per-driver + per-(driver,cyl) + optional per-customer
  // aggregates in one pass. Per-cylinder saleAmount comes from item.totalPrice
  // (sum of line prices for that cyl type) — never double-counts because each
  // item belongs to exactly one cylinder type. Money-received breakdowns
  // (collected/pending/overdue) stay at the driver level because they come
  // from invoice.outstandingAmount which is order-level, not per-item.
  type CylAgg = { cylinderTypeId: string; cylinderTypeName: string; fullsDelivered: number; emptiesCollected: number; saleAmount: number };
  type CustCylAgg = { cylinderTypeId: string; cylinderTypeName: string; fullsDelivered: number; emptiesCollected: number; saleAmount: number };
  type CustAgg = {
    customerId: string;
    customerName: string;
    orderIds: Set<string>;
    saleAmount: number;
    amountPending: number;
    amountOverdue: number;
    byCyl: Map<string, CustCylAgg>;
  };
  type DriverAgg = {
    driverId: string;
    driverName: string;
    orderIds: Set<string>;
    fullsDelivered: number;
    emptiesCollected: number;
    saleAmount: number;
    amountPending: number;
    amountOverdue: number;
    byCyl: Map<string, CylAgg>;
    byCustomer: Map<string, CustAgg>;
  };
  const byDriver = new Map<string, DriverAgg>();
  for (const o of orders) {
    // Godown-pickup orders (driverId=null) collapse into the synthetic bucket
    // so the same DriverAgg shape drives them. See constants above the
    // deliveryPerformance function.
    const did = o.isGodownPickup ? GODOWN_PICKUP_DRIVER_ID : o.driverId!;
    const name = o.isGodownPickup ? GODOWN_PICKUP_DRIVER_NAME : (o.driver?.driverName ?? 'Unknown');
    const agg =
      byDriver.get(did) ??
      ({
        driverId: did,
        driverName: name,
        orderIds: new Set<string>(),
        fullsDelivered: 0,
        emptiesCollected: 0,
        saleAmount: 0,
        amountPending: 0,
        amountOverdue: 0,
        byCyl: new Map<string, CylAgg>(),
        byCustomer: new Map<string, CustAgg>(),
      } as DriverAgg);

    // Order-level money aggregation runs ONCE per order (Set guard).
    if (!agg.orderIds.has(o.id)) {
      agg.orderIds.add(o.id);
      agg.saleAmount += num(o.totalAmount);
      if (o.invoice) {
        const outstanding = num(o.invoice.outstandingAmount);
        agg.amountPending += outstanding;
        if (o.invoice.dueDate && new Date(o.invoice.dueDate) < today && outstanding > 0) {
          agg.amountOverdue += outstanding;
        }
      }
    }

    // Per-customer aggregation (only used when includeCustomers=true, but
    // computed always — cheap in one pass).
    const cust =
      agg.byCustomer.get(o.customerId) ??
      ({
        customerId: o.customerId,
        customerName: o.customer?.customerName ?? 'Unknown',
        orderIds: new Set<string>(),
        saleAmount: 0,
        amountPending: 0,
        amountOverdue: 0,
        byCyl: new Map<string, CustCylAgg>(),
      } as CustAgg);
    if (!cust.orderIds.has(o.id)) {
      cust.orderIds.add(o.id);
      cust.saleAmount += num(o.totalAmount);
      if (o.invoice) {
        const outstanding = num(o.invoice.outstandingAmount);
        cust.amountPending += outstanding;
        if (o.invoice.dueDate && new Date(o.invoice.dueDate) < today && outstanding > 0) {
          cust.amountOverdue += outstanding;
        }
      }
    }

    // Item-level operational aggregation (per cylinder type).
    for (const it of o.items) {
      const cyl = it.cylinderTypeId ?? '__unknown__';
      const cylName = it.cylinderType?.typeName ?? '—';
      const fulls = it.deliveredQuantity ?? it.quantity ?? 0;
      const empties = it.emptiesCollected ?? 0;
      const lineSale = num(it.totalPrice);
      agg.fullsDelivered += fulls;
      agg.emptiesCollected += empties;

      const cylAgg =
        agg.byCyl.get(cyl) ??
        ({ cylinderTypeId: cyl, cylinderTypeName: cylName, fullsDelivered: 0, emptiesCollected: 0, saleAmount: 0 } as CylAgg);
      cylAgg.fullsDelivered += fulls;
      cylAgg.emptiesCollected += empties;
      cylAgg.saleAmount += lineSale;
      agg.byCyl.set(cyl, cylAgg);

      const custCylAgg =
        cust.byCyl.get(cyl) ??
        ({ cylinderTypeId: cyl, cylinderTypeName: cylName, fullsDelivered: 0, emptiesCollected: 0, saleAmount: 0 } as CustCylAgg);
      custCylAgg.fullsDelivered += fulls;
      custCylAgg.emptiesCollected += empties;
      custCylAgg.saleAmount += lineSale;
      cust.byCyl.set(cyl, custCylAgg);
    }
    agg.byCustomer.set(o.customerId, cust);

    byDriver.set(did, agg);
  }

  // Step 4 — flatten into row array: driver_summary followed by its
  // cylinder_row children, followed (only when includeCustomers=true) by
  // customer_row entries per customer this driver served.
  //
  // Per-customer money collected: allocated from paymentAllocations joined
  // through invoice → order.customerId. Loaded once, keyed by customerId.
  const collectedByCustomer = new Map<string, number>();
  if (f.includeCustomers) {
    const custAllocs = invoiceIds.length
      ? await prisma.paymentAllocation.findMany({
          where: { invoiceId: { in: invoiceIds } },
          select: {
            allocatedAmount: true,
            invoice: { select: { order: { select: { customerId: true } } } },
          },
        })
      : [];
    for (const a of custAllocs) {
      const cid = a.invoice.order?.customerId;
      if (!cid) continue;
      collectedByCustomer.set(cid, (collectedByCustomer.get(cid) ?? 0) + num(a.allocatedAmount));
    }
  }

  const rows: Record<string, unknown>[] = [];
  const drivers = [...byDriver.values()].sort((a, b) => b.saleAmount - a.saleAmount);
  for (const d of drivers) {
    const collected = collectedByDriver.get(d.driverId) ?? 0;
    rows.push({
      type: 'driver_summary',
      driverId: d.driverId,
      driverName: d.driverName,
      customerName: '',
      cylinderTypeName: 'ALL',
      totalOrders: d.orderIds.size,
      fullsDelivered: d.fullsDelivered,
      emptiesCollected: d.emptiesCollected,
      saleAmount: +d.saleAmount.toFixed(2),
      amountCollected: +collected.toFixed(2),
      amountPending: +d.amountPending.toFixed(2),
      amountOverdue: +d.amountOverdue.toFixed(2),
    });
    for (const c of [...d.byCyl.values()].sort((a, b) => a.cylinderTypeName.localeCompare(b.cylinderTypeName))) {
      rows.push({
        type: 'cylinder_row',
        driverId: d.driverId,
        driverName: d.driverName,
        customerName: '',
        cylinderTypeId: c.cylinderTypeId,
        cylinderTypeName: c.cylinderTypeName,
        fullsDelivered: c.fullsDelivered,
        emptiesCollected: c.emptiesCollected,
        // Per-cylinder Sale Amount comes from sum(item.totalPrice) — clean
        // per-item attribution (each item belongs to exactly one cyl type).
        saleAmount: +c.saleAmount.toFixed(2),
        // Money-received breakdown stays at driver level. Cylinder-level
        // collected/pending/overdue would require proportional split of
        // invoice.outstandingAmount and can't be honestly attributed per item.
        amountCollected: '',
        amountPending: '',
        amountOverdue: '',
      });
    }

    if (f.includeCustomers) {
      const custs = [...d.byCustomer.values()].sort((a, b) => b.saleAmount - a.saleAmount);
      for (const cust of custs) {
        const custCollected = collectedByCustomer.get(cust.customerId) ?? 0;
        const cylList = [...cust.byCyl.values()].sort((a, b) => a.cylinderTypeName.localeCompare(b.cylinderTypeName));
        cylList.forEach((cyl, idx) => {
          rows.push({
            type: 'customer_row',
            driverId: d.driverId,
            driverName: d.driverName,
            customerId: cust.customerId,
            customerName: cust.customerName,
            cylinderTypeId: cyl.cylinderTypeId,
            cylinderTypeName: cyl.cylinderTypeName,
            fullsDelivered: cyl.fullsDelivered,
            emptiesCollected: cyl.emptiesCollected,
            saleAmount: +cyl.saleAmount.toFixed(2),
            // Money-received breakdown lives only on the first cylinder row
            // per customer to keep CSV sums honest.
            amountCollected: idx === 0 ? +custCollected.toFixed(2) : '',
            amountPending: idx === 0 ? +cust.amountPending.toFixed(2) : '',
            amountOverdue: idx === 0 ? +cust.amountOverdue.toFixed(2) : '',
          });
        });
      }
    }
  }

  const chart: ReportChart = {
    type: 'bar',
    title: 'Sale Amount by Driver',
    data: {
      labels: drivers.map((d) => d.driverName),
      series: [
        { name: 'Sale', values: drivers.map((d) => +d.saleAmount.toFixed(2)) },
        { name: 'Collected', values: drivers.map((d) => +(collectedByDriver.get(d.driverId) ?? 0).toFixed(2)) },
        { name: 'Pending', values: drivers.map((d) => +d.amountPending.toFixed(2)) },
      ],
    },
  };

  const totals = drivers.reduce(
    (acc, d) => {
      acc.totalOrders += d.orderIds.size;
      acc.fullsDelivered += d.fullsDelivered;
      acc.emptiesCollected += d.emptiesCollected;
      acc.saleAmount += d.saleAmount;
      acc.amountCollected += collectedByDriver.get(d.driverId) ?? 0;
      acc.amountPending += d.amountPending;
      acc.amountOverdue += d.amountOverdue;
      return acc;
    },
    { totalOrders: 0, fullsDelivered: 0, emptiesCollected: 0, saleAmount: 0, amountCollected: 0, amountPending: 0, amountOverdue: 0 },
  );

  const columns: ReportColumn[] = [
    { key: 'driverName', label: 'Driver' },
    ...(f.includeCustomers ? [{ key: 'customerName', label: 'Customer' }] : []),
    { key: 'cylinderTypeName', label: 'Cylinder Type' },
    { key: 'fullsDelivered', label: 'Fulls Delivered' },
    { key: 'emptiesCollected', label: 'Empties Collected' },
    { key: 'saleAmount', label: 'Sale Amount', money: true },
    { key: 'amountCollected', label: 'Collected', money: true },
    { key: 'amountPending', label: 'Pending', money: true },
    { key: 'amountOverdue', label: 'Overdue', money: true },
  ];

  return {
    columns,
    rows,
    totals: {
      driverName: 'TOTAL',
      ...(f.includeCustomers ? { customerName: '—' } : {}),
      cylinderTypeName: '—',
      fullsDelivered: totals.fullsDelivered,
      emptiesCollected: totals.emptiesCollected,
      saleAmount: +totals.saleAmount.toFixed(2),
      amountCollected: +totals.amountCollected.toFixed(2),
      amountPending: +totals.amountPending.toFixed(2),
      amountOverdue: +totals.amountOverdue.toFixed(2),
    },
    chart,
  };
}

// Drill-down — per-customer rows for a single driver in the range.
// pendingEmpties comes from CustomerInventoryBalance and is CUSTOMER-LEVEL
// cumulative (across every driver that ever served that customer). Frontend
// labels this clearly to avoid misattribution.
async function deliveryPerformanceDrilldown(
  distributorId: string,
  driverId: string,
  from: Date,
  to: Date,
): Promise<ReportResult> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // The synthetic godown-pickup bucket drill-down: filter on
  // isGodownPickup=true (no real driver). All other flow is identical —
  // godown orders group by customer just like any driver's orders do.
  const isGodown = driverId === GODOWN_PICKUP_DRIVER_ID;
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      ...(isGodown
        ? { isGodownPickup: true }
        : { driverId, isGodownPickup: false }),
      status: { in: ['delivered', 'modified_delivered'] },
      deliveryDate: { gte: from, lte: to },
      deletedAt: null,
    },
    select: {
      id: true,
      customerId: true,
      totalAmount: true,
      customer: { select: { customerName: true } },
      items: {
        select: {
          cylinderTypeId: true,
          quantity: true,
          deliveredQuantity: true,
          emptiesCollected: true,
          cylinderType: { select: { typeName: true } },
        },
      },
      invoice: {
        select: {
          id: true,
          outstandingAmount: true,
          dueDate: true,
          status: true,
        },
      },
    },
  });

  const invoiceIds = orders.map((o) => o.invoice?.id).filter((v): v is string => Boolean(v));
  const allocations = invoiceIds.length
    ? await prisma.paymentAllocation.findMany({
        where: { invoiceId: { in: invoiceIds } },
        select: {
          allocatedAmount: true,
          invoice: { select: { id: true, order: { select: { customerId: true } } } },
        },
      })
    : [];
  // Money aggregates run per-customer (an order belongs to one customer).
  const collectedByCustomer = new Map<string, number>();
  for (const a of allocations) {
    const cid = a.invoice.order?.customerId;
    if (!cid) continue;
    collectedByCustomer.set(cid, (collectedByCustomer.get(cid) ?? 0) + num(a.allocatedAmount));
  }

  // Pending empties: fetch one row per (customerId, cylinderTypeId) for the
  // customers that appear in this driver's range. Attribute cumulative
  // customer-level balance to the (customer,cyl) grid.
  const customerIds = [...new Set(orders.map((o) => o.customerId))];
  const balances = customerIds.length
    ? await prisma.customerInventoryBalance.findMany({
        where: { customerId: { in: customerIds } },
        select: { customerId: true, cylinderTypeId: true, withCustomerQty: true },
      })
    : [];
  const pendingKey = (cid: string, cylId: string) => `${cid}|${cylId}`;
  const pendingByCustomerCyl = new Map<string, number>();
  for (const b of balances) {
    pendingByCustomerCyl.set(pendingKey(b.customerId, b.cylinderTypeId), b.withCustomerQty);
  }

  // Group per (customer, cylinder). Money aggregated per customer, then
  // reported on the FIRST cylinder row for that customer (blank on the rest)
  // to avoid double-counting on CSV export.
  type CustCylAgg = {
    customerId: string;
    customerName: string;
    cylinderTypeId: string;
    cylinderTypeName: string;
    fullsDelivered: number;
    emptiesCollected: number;
  };
  type CustAgg = {
    customerId: string;
    customerName: string;
    orderIds: Set<string>;
    saleAmount: number;
    amountPending: number;
    amountOverdue: number;
    byCyl: Map<string, CustCylAgg>;
  };
  const byCustomer = new Map<string, CustAgg>();
  for (const o of orders) {
    const cid = o.customerId;
    const agg =
      byCustomer.get(cid) ??
      ({
        customerId: cid,
        customerName: o.customer?.customerName ?? 'Unknown',
        orderIds: new Set<string>(),
        saleAmount: 0,
        amountPending: 0,
        amountOverdue: 0,
        byCyl: new Map<string, CustCylAgg>(),
      } as CustAgg);
    if (!agg.orderIds.has(o.id)) {
      agg.orderIds.add(o.id);
      agg.saleAmount += num(o.totalAmount);
      if (o.invoice) {
        const outstanding = num(o.invoice.outstandingAmount);
        agg.amountPending += outstanding;
        if (o.invoice.dueDate && new Date(o.invoice.dueDate) < today && outstanding > 0) {
          agg.amountOverdue += outstanding;
        }
      }
    }
    for (const it of o.items) {
      const cyl = it.cylinderTypeId ?? '__unknown__';
      const cylName = it.cylinderType?.typeName ?? '—';
      const fulls = it.deliveredQuantity ?? it.quantity ?? 0;
      const empties = it.emptiesCollected ?? 0;
      const cylAgg =
        agg.byCyl.get(cyl) ??
        ({
          customerId: cid,
          customerName: agg.customerName,
          cylinderTypeId: cyl,
          cylinderTypeName: cylName,
          fullsDelivered: 0,
          emptiesCollected: 0,
        } as CustCylAgg);
      cylAgg.fullsDelivered += fulls;
      cylAgg.emptiesCollected += empties;
      agg.byCyl.set(cyl, cylAgg);
    }
    byCustomer.set(cid, agg);
  }

  const rows: Record<string, unknown>[] = [];
  const custs = [...byCustomer.values()].sort((a, b) => b.saleAmount - a.saleAmount);
  for (const c of custs) {
    const cylList = [...c.byCyl.values()].sort((a, b) => a.cylinderTypeName.localeCompare(b.cylinderTypeName));
    const collected = collectedByCustomer.get(c.customerId) ?? 0;
    cylList.forEach((cyl, idx) => {
      rows.push({
        type: 'customer_row',
        customerId: c.customerId,
        customerName: c.customerName,
        cylinderTypeId: cyl.cylinderTypeId,
        cylinderTypeName: cyl.cylinderTypeName,
        fullsDelivered: cyl.fullsDelivered,
        emptiesCollected: cyl.emptiesCollected,
        pendingEmpties: pendingByCustomerCyl.get(pendingKey(c.customerId, cyl.cylinderTypeId)) ?? 0,
        // Money on the first cylinder row per customer only — visual grouping
        // in the UI + honest sums on CSV export.
        saleAmount: idx === 0 ? +c.saleAmount.toFixed(2) : '',
        amountCollected: idx === 0 ? +collected.toFixed(2) : '',
        amountPending: idx === 0 ? +c.amountPending.toFixed(2) : '',
        amountOverdue: idx === 0 ? +c.amountOverdue.toFixed(2) : '',
      });
    });
  }

  const totals = custs.reduce(
    (acc, c) => {
      acc.saleAmount += c.saleAmount;
      acc.amountCollected += collectedByCustomer.get(c.customerId) ?? 0;
      acc.amountPending += c.amountPending;
      acc.amountOverdue += c.amountOverdue;
      for (const cyl of c.byCyl.values()) {
        acc.fullsDelivered += cyl.fullsDelivered;
        acc.emptiesCollected += cyl.emptiesCollected;
      }
      return acc;
    },
    { fullsDelivered: 0, emptiesCollected: 0, saleAmount: 0, amountCollected: 0, amountPending: 0, amountOverdue: 0 },
  );

  return {
    columns: [
      { key: 'customerName', label: 'Customer' },
      { key: 'cylinderTypeName', label: 'Cylinder Type' },
      { key: 'fullsDelivered', label: 'Fulls Delivered' },
      { key: 'emptiesCollected', label: 'Empties Collected' },
      { key: 'pendingEmpties', label: 'Pending Empties *' },
      { key: 'saleAmount', label: 'Sale Amount', money: true },
      { key: 'amountCollected', label: 'Collected', money: true },
      { key: 'amountPending', label: 'Pending', money: true },
      { key: 'amountOverdue', label: 'Overdue', money: true },
    ],
    rows,
    totals: {
      customerName: 'TOTAL',
      cylinderTypeName: '—',
      fullsDelivered: totals.fullsDelivered,
      emptiesCollected: totals.emptiesCollected,
      pendingEmpties: '—',
      saleAmount: +totals.saleAmount.toFixed(2),
      amountCollected: +totals.amountCollected.toFixed(2),
      amountPending: +totals.amountPending.toFixed(2),
      amountOverdue: +totals.amountOverdue.toFixed(2),
    },
  };
}

// ─── Driver Statement — one row per invoice for one driver ─────────────────
//
// Triggered by ?groupBy=invoice&driverId=X. Returns per-invoice detail rows
// with 11 columns (see COLUMNS below) so the ops team can scan every touch
// a driver had in the period: date, invoice, customer, cylinders (compact
// per-order string), fulls/empties, credit period, status, overdue amount.
//
// Money-received per invoice comes from paymentAllocations (invoice-scoped
// so the reader can identify which invoices are paid vs unpaid).
export async function deliveryPerformanceStatement(
  distributorId: string,
  driverId: string,
  from: Date,
  to: Date,
  statusFilter: 'all' | 'paid' | 'partial' | 'pending' | 'overdue',
): Promise<ReportResult> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Same synthetic-bucket handling as the summary + drilldown paths so a
  // click on the Godown Pickup driver row's "Statement" opens the per-invoice
  // list of godown-pickup invoices.
  const isGodown = driverId === GODOWN_PICKUP_DRIVER_ID;
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      ...(isGodown
        ? { isGodownPickup: true }
        : { driverId, isGodownPickup: false }),
      status: { in: ['delivered', 'modified_delivered'] },
      deliveryDate: { gte: from, lte: to },
      deletedAt: null,
    },
    select: {
      id: true,
      customerId: true,
      totalAmount: true,
      customer: { select: { customerName: true, creditPeriodDays: true } },
      driver: { select: { driverName: true } },
      items: {
        select: {
          cylinderTypeId: true,
          quantity: true,
          deliveredQuantity: true,
          emptiesCollected: true,
          cylinderType: { select: { typeName: true } },
        },
      },
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          issueDate: true,
          dueDate: true,
          totalAmount: true,
          amountPaid: true,
          outstandingAmount: true,
          status: true,
        },
      },
    },
    orderBy: { deliveryDate: 'asc' },
  });

  // Drop orders whose invoice is missing or cancelled — per Q4 (excluded).
  const usable = orders.filter((o) => o.invoice && o.invoice.status !== 'cancelled');
  const invoiceIds = usable.map((o) => o.invoice!.id);

  // (2026-08-08) The per-customer pending-empties lookup that fed the old
  // "E Pend" column was removed with that column — Suneel dropped E Pend
  // from the Driver Statement modal + Excel to de-congest the view.

  // Money-received per invoice.
  const allocations = invoiceIds.length
    ? await prisma.paymentAllocation.findMany({
        where: { invoiceId: { in: invoiceIds } },
        select: { invoiceId: true, allocatedAmount: true },
      })
    : [];
  const collectedByInvoice = new Map<string, number>();
  for (const a of allocations) {
    collectedByInvoice.set(a.invoiceId, (collectedByInvoice.get(a.invoiceId) ?? 0) + num(a.allocatedAmount));
  }

  // Emit one row per invoice. Compose the compact cylinder-mix string
  // ("5×19KG, 2×47.5LOT") and total fulls / empties across the order's items.
  type Row = {
    type: 'statement_row';
    invoiceId: string;
    date: string;
    invoiceNumber: string;
    customerId: string;
    customerName: string;
    cylinders: string;
    emptiesSplit: string;
    fullsDelivered: number;
    emptiesCollected: number;
    amount: number;
    creditDays: number;
    status: InvoiceStatus;
    amountCollected: number;
    overdueAmount: number | '';
  };
  const rows: Row[] = [];
  const kpiCounts = { paid: 0, partial: 0, pending: 0, overdue: 0 } as Record<Lowercase<InvoiceStatus>, number>;
  const kpiSums = { billed: 0, collected: 0, pending: 0, overdue: 0 };

  for (const o of usable) {
    const inv = o.invoice!;
    // Aggregate cylinder-type mix across this invoice's line items.
    // Multiple items of the same cyl type collapse into one entry.
    // Track BOTH fulls delivered and empties collected per cyl type so the
    // report can show a Fulls Split and a parallel Empties Split (Suneel
    // 2026-08-08 — empties were previously only a flat total).
    const cylMix = new Map<string, { name: string; qty: number; empties: number }>();
    let totalFulls = 0;
    let totalEmpties = 0;
    for (const it of o.items) {
      const key = it.cylinderTypeId ?? '__unknown__';
      const name = it.cylinderType?.typeName ?? '—';
      const qty = it.deliveredQuantity ?? it.quantity ?? 0;
      const empties = it.emptiesCollected ?? 0;
      totalFulls += qty;
      totalEmpties += empties;
      const cur = cylMix.get(key) ?? { name, qty: 0, empties: 0 };
      cur.qty += qty;
      cur.empties += empties;
      cylMix.set(key, cur);
    }
    const sortedMix = [...cylMix.values()].sort((a, b) => a.name.localeCompare(b.name));
    // Fulls Split (was "Cylinders"): "5×19 KG, 2×47.5 LOT".
    const cylinders = sortedMix
      .filter((c) => c.qty > 0)
      .map((c) => `${c.qty}×${c.name}`)
      .join(', ');
    // Empties Split: same shape, only cyl types where empties were collected.
    const emptiesSplit = sortedMix
      .filter((c) => c.empties > 0)
      .map((c) => `${c.empties}×${c.name}`)
      .join(', ');

    // Item-8 fix: derive Overdue live from `issueDate + creditPeriodDays`
    // rather than the frozen `invoice.dueDate` snapshot. `creditDays`
    // shown in the report is now the customer's CURRENT credit period
    // (not the reversed-difference from the stored dueDate).
    const creditDays = o.customer?.creditPeriodDays ?? 0;
    const status = invoiceStatus(
      { ...inv, issueDate: inv.issueDate, creditPeriodDays: creditDays },
      today,
    );
    const outstanding = num(inv.outstandingAmount);
    const collected = collectedByInvoice.get(inv.id) ?? 0;

    // KPI accumulators run BEFORE status-filter so the modal chip counts
    // reflect the true breakdown even when the user is looking at a subset.
    kpiCounts[status.toLowerCase() as Lowercase<InvoiceStatus>] += 1;
    kpiSums.billed += num(inv.totalAmount);
    kpiSums.collected += collected;
    kpiSums.pending += outstanding;
    if (status === 'Overdue') kpiSums.overdue += outstanding;

    // Apply status filter.
    if (statusFilter !== 'all' && status.toLowerCase() !== statusFilter) continue;

    rows.push({
      type: 'statement_row',
      invoiceId: inv.id,
      date: (inv.issueDate ? new Date(inv.issueDate) : new Date()).toISOString().slice(0, 10),
      invoiceNumber: inv.invoiceNumber,
      customerId: o.customerId,
      customerName: o.customer?.customerName ?? 'Unknown',
      cylinders,
      emptiesSplit,
      fullsDelivered: totalFulls,
      emptiesCollected: totalEmpties,
      amount: num(inv.totalAmount),
      creditDays,
      status,
      amountCollected: +collected.toFixed(2),
      // 2026-07-17: renamed to "Balance Due" in the column label. Populate
      // for EVERY non-Paid row (Overdue + Partial + Pending) — the previous
      // "only when Overdue" gate hid partial-payment tails (like the
      // ₹4-₹28 rounding balances) that made the Driver Statement look like
      // it was showing full invoice value in the Amount column instead of
      // actual pending. Status column still tells the reader which bucket
      // (Overdue vs Partial vs Pending). The blank stays only for 'Paid'.
      overdueAmount: status === 'Paid' ? '' : +outstanding.toFixed(2),
    });
  }

  // Totals row — matches Amount / Collected / Overdue Amt columns.
  const totalsAmount = rows.reduce((s, r) => s + r.amount, 0);
  const totalsCollected = rows.reduce((s, r) => s + (r.amountCollected as number), 0);
  const totalsOverdue = rows.reduce((s, r) => s + (r.overdueAmount === '' ? 0 : (r.overdueAmount as number)), 0);
  const totalsFulls = rows.reduce((s, r) => s + r.fullsDelivered, 0);
  const totalsEmpties = rows.reduce((s, r) => s + r.emptiesCollected, 0);

  const driverName = usable[0]?.driver?.driverName ?? 'Unknown';

  return {
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'invoiceNumber', label: 'Invoice #' },
      { key: 'customerName', label: 'Customer' },
      { key: 'cylinders', label: 'Fulls Split' },
      { key: 'emptiesSplit', label: 'Empties Split' },
      { key: 'fullsDelivered', label: 'F Del' },
      { key: 'emptiesCollected', label: 'E Coll' },
      { key: 'amount', label: 'Amount', money: true },
      { key: 'creditDays', label: 'Cr Days' },
      { key: 'status', label: 'Status' },
      { key: 'overdueAmount', label: 'Balance Due', money: true },
    ],
    rows,
    totals: {
      date: 'TOTAL',
      invoiceNumber: `${rows.length} invoice${rows.length === 1 ? '' : 's'}`,
      customerName: '',
      cylinders: '',
      emptiesSplit: '',
      fullsDelivered: totalsFulls,
      emptiesCollected: totalsEmpties,
      amount: +totalsAmount.toFixed(2),
      creditDays: '',
      status: '',
      overdueAmount: +totalsOverdue.toFixed(2),
      // Extra fields consumed by the modal KPI strip — not table columns.
      _driverName: driverName,
      _kpiCounts: kpiCounts,
      _kpiSums: {
        billed: +kpiSums.billed.toFixed(2),
        collected: +kpiSums.collected.toFixed(2),
        pending: +kpiSums.pending.toFixed(2),
        overdue: +kpiSums.overdue.toFixed(2),
      },
      _totalsCollected: +totalsCollected.toFixed(2),
    },
  };
}

// ─── Report 5 — Inventory Movement ───────────────────────────────────────────
export async function inventoryMovement(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const summaries = await prisma.inventorySummary.findMany({
    where: { distributorId, summaryDate: { gte: from, lte: to }, ...(f.cylinderTypeId ? { cylinderTypeId: f.cylinderTypeId } : {}) },
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: [{ summaryDate: 'asc' }],
  });
  const rows = summaries.map((s) => ({
    date: dayKey(new Date(s.summaryDate)),
    cylinderType: s.cylinderType?.typeName ?? '—',
    opening: s.openingFulls,
    dispatched: s.dispatchedQty,
    delivered: s.deliveredQty,
    returns: s.cancelledStockQty,
    closing: s.closingFulls,
  }));
  return {
    columns: [
      { key: 'date', label: 'Date' }, { key: 'cylinderType', label: 'Cylinder Type' },
      { key: 'opening', label: 'Opening' }, { key: 'dispatched', label: 'Dispatched' },
      { key: 'delivered', label: 'Delivered' }, { key: 'returns', label: 'Cancelled Returns' },
      { key: 'closing', label: 'Closing' },
    ],
    rows,
  };
}

// ─── Report 6 — Customer Statement ───────────────────────────────────────────
//
// Fix D (2026-06-11): mirrors the PDF behaviour from G1 fixup. Always
// emit an explicit "Opening Balance b/f" row at the top whenever there
// is non-zero pre-range debt OR any opening-balance invoice exists for
// the customer (regardless of when it was imported). OB entries that
// happen to fall inside [from, to] are FOLDED into the b/f row instead
// of appearing as confusing `invoice_entry` rows — the same fold pattern
// keeps the report aligned with the PDF and the in-app modal.
export async function customerStatement(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  if (!f.customerId) throw Object.assign(new Error('customerId is required for the Customer Statement report'), { statusCode: 400 });
  const { from, to } = range(f);

  // All ledger entries for the customer (entire history, not just range)
  // so we can fold every OB entry into the b/f row irrespective of date.
  const allEntries = await prisma.customerLedgerEntry.findMany({
    where: { distributorId, customerId: f.customerId },
    orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
  });

  // Preload referenced invoices once to identify OB entries cheaply.
  const invoiceIds = Array.from(
    new Set(allEntries.map((e) => e.invoiceId).filter((x): x is string => !!x)),
  );
  const obIds = invoiceIds.length === 0
    ? new Set<string>()
    : new Set(
        (await prisma.invoice.findMany({
          where: { id: { in: invoiceIds }, isOpeningBalance: true },
          select: { id: true },
        })).map((i) => i.id),
      );

  // Carry-forward = pre-range entries + every OB entry (even if in-range).
  // Deposit ledger (2026-07-31) — exclude deposit_charged / deposit_refunded
  // rows for the same reason described in the running-balance loop below:
  // they're metadata, not money movement. Including them here would inflate
  // the opening b/f figure for any customer with a deposit history.
  let carryForward = 0;
  for (const e of allEntries) {
    if (e.entryType === 'deposit_charged' || e.entryType === 'deposit_refunded') continue;
    const isOB = !!(e.invoiceId && obIds.has(e.invoiceId));
    if (isOB || e.entryDate < from) carryForward += num(e.amountDelta);
  }

  const rows: Array<{
    date: string; type: string; narration: string;
    debit: number | string; credit: number | string; balance: number;
  }> = [];

  if (Math.abs(carryForward) > 0.005) {
    // b/f date = `from − 1 day` so the reader sees it pre-period.
    const bfDate = new Date(from.getTime() - 86400000);
    rows.push({
      date: dayKey(bfDate),
      type: 'opening',
      narration: 'Opening Balance b/f',
      debit: carryForward > 0 ? +carryForward.toFixed(2) : 0,
      credit: carryForward < 0 ? +(-carryForward).toFixed(2) : 0,
      balance: +carryForward.toFixed(2),
    });
  }

  let running = carryForward;
  for (const e of allEntries) {
    const inRange = e.entryDate >= from && e.entryDate <= to;
    if (!inRange) continue;
    const isOB = !!(e.invoiceId && obIds.has(e.invoiceId));
    if (isOB) continue; // already folded into b/f above
    // Q3 (2026-07-09) — stock-only empties-return row. amountDelta is 0
    // so `running` is unchanged. We render debit/credit as empty strings
    // (not 0) and label the type "Empties Return" so an accountant reading
    // this doesn't parse it as a real money movement.
    const isEmptiesReturn = e.entryType === 'empties_return';
    // F1 (2026-08-06) — defective_collected rows have amountDelta=0 by
    // construction (writer enforces). Treat exactly like empties_return
    // in this XLSX renderer: blank debit/credit, labeled type, doesn't
    // move running balance (the +0 is defensive).
    const isDefectiveCollected = e.entryType === 'defective_collected';
    // Deposit ledger (2026-07-31) — cylinder-deposit rows are METADATA:
    // the actual money movement is booked in the companion
    // payment_entry (charge) or CreditNote/negative-payment (refund)
    // row emitted alongside. Summing amountDelta here would DOUBLE
    // COUNT the deposit into the customer's account balance. Render
    // debit/credit blank (like empties_return) and skip the running
    // update. The deposit history is still visible in this report via
    // the narration + type columns.
    const isDepositRow = e.entryType === 'deposit_charged' || e.entryType === 'deposit_refunded';
    if (!isDepositRow) {
      running += num(e.amountDelta);
    }
    const typeLabel = isEmptiesReturn ? 'Empties Return'
      : isDefectiveCollected ? 'Defective Return'
      : e.entryType === 'deposit_charged' ? 'Deposit Received'
      : e.entryType === 'deposit_refunded' ? 'Deposit Refunded'
      : e.entryType.replace(/_entry$/, '');
    rows.push({
      date: dayKey(new Date(e.entryDate)),
      type: typeLabel,
      narration: e.narration ?? '',
      debit: (isEmptiesReturn || isDefectiveCollected || isDepositRow) ? '' : (num(e.amountDelta) > 0 ? num(e.amountDelta) : 0),
      credit: (isEmptiesReturn || isDefectiveCollected || isDepositRow) ? '' : (num(e.amountDelta) < 0 ? -num(e.amountDelta) : 0),
      balance: +running.toFixed(2),
    });
  }

  return {
    columns: [
      { key: 'date', label: 'Date' }, { key: 'type', label: 'Type' }, { key: 'narration', label: 'Narration' },
      { key: 'debit', label: 'Debit', money: true }, { key: 'credit', label: 'Credit', money: true },
      { key: 'balance', label: 'Balance', money: true },
    ],
    rows,
    totals: { date: '', type: '', narration: 'Closing Balance', debit: '', credit: '', balance: +running.toFixed(2) },
  };
}

// ─── Report 7 — Vehicle Ledger ───────────────────────────────────────────────
// Per-vehicle (per-trip or per-day) physical movement of cylinders, built
// entirely from inventory_events (no new table). Attribution of each event to a
// vehicle/driver/trip is resolved through the originating order / DVA / cancelled
// stock event.
//
// 2026-08-05 F3 — Corporation-loads (OMC → depot inbound) are NO LONGER
// returned here. They live on Inventory → Depot History exclusively.
// See F3 comment inside vehicleLedger() for the fetch-level exclusion.
type LedgerAttr = { vehicleId: string | null; vehicleNumber: string; driverName: string; tripNumber: number | null };
export async function vehicleLedger(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const groupBy: 'trip' | 'day' = f.groupBy === 'trip' ? 'trip' : 'day';

  const movementTypes = ['dispatch', 'delivery', 'collection', 'returns_collection', 'reconciliation_empties_return', 'cancellation_return'] as const;
  // 2026-07-27 — backdated trips (applyBackdatedInventoryAdjustment) emit a
  // `manual_adjustment` fulls debit as the "delivery" leg. Include those
  // rows in the fetch ONLY when `referenceType='backdated_inventory_adjustment'`
  // so genuine "Adjust Stock" corrections (referenceType=null) remain
  // invisible to the vehicle ledger. See feedback_backdated_trip_visibility
  // and the audit that confirmed only 3 null-refType rows exist in prod.
  //
  // 2026-08-05 F3 — `incoming_fulls` (OMC → depot inbound loads) NO LONGER
  // fetched here. They belong to Depot History (Inventory → Depot History
  // tab), not to a per-vehicle customer trip ledger. Suneel's directive:
  // "we don't need to show corporation loads at all because they are
  // already in depot history."
  const events = await prisma.inventoryEvent.findMany({
    where: {
      distributorId,
      eventDate: { gte: from, lte: to },
      OR: [
        { eventType: { in: [...movementTypes] } },
        { eventType: 'manual_adjustment', referenceType: 'backdated_inventory_adjustment' },
      ],
      ...(f.cylinderTypeId ? { cylinderTypeId: f.cylinderTypeId } : {}),
    },
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: { eventDate: 'asc' },
  });

  // ── Attribution maps ──────────────────────────────────────────────────────
  // referenceType → what reference_id points to:
  //   order                            → Order.id
  //   driver_vehicle_assignment        → DVA.id
  //   cancelled_stock                  → CancelledStockEvent.id
  //   dva_load_manifest                → DVALoadManifest.id (→ .dvaId → DVA)
  //   godown_pickup                    → Order.id (synthetic bucket)
  //   mini_operator_order              → Order.id
  //   backdated_inventory_adjustment   → Order.id
  const orderIds = new Set<string>();
  const dvaIds = new Set<string>();
  const cseIds = new Set<string>();
  const manifestIds = new Set<string>();
  for (const e of events) {
    if (!e.referenceId) continue;
    switch (e.referenceType) {
      case 'order':
      case 'godown_pickup':
      case 'mini_operator_order':
      case 'backdated_inventory_adjustment':
        orderIds.add(e.referenceId); break;
      case 'driver_vehicle_assignment':
        dvaIds.add(e.referenceId); break;
      case 'cancelled_stock':
        cseIds.add(e.referenceId); break;
      case 'dva_load_manifest':
        manifestIds.add(e.referenceId); break;
    }
  }

  const [orders, dvas, cses, manifests] = await Promise.all([
    orderIds.size
      ? prisma.order.findMany({
          where: { id: { in: [...orderIds] } },
          select: { id: true, vehicleId: true, tripNumber: true, isGodownPickup: true, vehicle: { select: { vehicleNumber: true } }, driver: { select: { driverName: true } } },
        })
      : Promise.resolve([]),
    dvaIds.size
      ? prisma.driverVehicleAssignment.findMany({
          where: { id: { in: [...dvaIds] } },
          select: { id: true, vehicleId: true, tripNumber: true, vehicle: { select: { vehicleNumber: true } }, driver: { select: { driverName: true } } },
        })
      : Promise.resolve([]),
    cseIds.size
      ? prisma.cancelledStockEvent.findMany({
          where: { id: { in: [...cseIds] } },
          select: { id: true, vehicleId: true, vehicle: { select: { vehicleNumber: true } }, driver: { select: { driverName: true } }, order: { select: { tripNumber: true } } },
        })
      : Promise.resolve([]),
    manifestIds.size
      ? prisma.dVALoadManifest.findMany({
          where: { id: { in: [...manifestIds] } },
          select: { id: true, dva: { select: { id: true, vehicleId: true, tripNumber: true, vehicle: { select: { vehicleNumber: true } }, driver: { select: { driverName: true } } } } },
        })
      : Promise.resolve([]),
  ]);

  // Godown-pickup orders read as a synthetic "GODOWN" bucket, not a real
  // vehicle/driver — mirrors deliveryPerformance's GODOWN_PICKUP_DRIVER_*
  // treatment so both reports agree on the presentation.
  const orderAttr = new Map<string, LedgerAttr>(orders.map((o) => [o.id, o.isGodownPickup
    ? { vehicleId: null, vehicleNumber: 'GODOWN', driverName: 'Godown Pickup', tripNumber: o.tripNumber ?? null }
    : { vehicleId: o.vehicleId, vehicleNumber: o.vehicle?.vehicleNumber ?? '—', driverName: o.driver?.driverName ?? '—', tripNumber: o.tripNumber ?? null }]));
  const dvaAttr = new Map<string, LedgerAttr>(dvas.map((d) => [d.id, { vehicleId: d.vehicleId, vehicleNumber: d.vehicle?.vehicleNumber ?? '—', driverName: d.driver?.driverName ?? '—', tripNumber: d.tripNumber ?? null }]));
  const cseAttr = new Map<string, LedgerAttr>(cses.map((c) => [c.id, { vehicleId: c.vehicleId, vehicleNumber: c.vehicle?.vehicleNumber ?? '—', driverName: c.driver?.driverName ?? '—', tripNumber: c.order?.tripNumber ?? null }]));
  const manifestAttr = new Map<string, LedgerAttr>(manifests.map((m) => [m.id, m.dva
    ? { vehicleId: m.dva.vehicleId, vehicleNumber: m.dva.vehicle?.vehicleNumber ?? '—', driverName: m.dva.driver?.driverName ?? '—', tripNumber: m.dva.tripNumber ?? null }
    : { vehicleId: null, vehicleNumber: '—', driverName: '—', tripNumber: null }]));

  const attrFor = (e: (typeof events)[number]): LedgerAttr => {
    if (!e.referenceId) {
      return { vehicleId: null, vehicleNumber: e.vehicleNumber ?? '—', driverName: e.driverName ?? '—', tripNumber: null };
    }
    switch (e.referenceType) {
      case 'order':
      case 'godown_pickup':
      case 'mini_operator_order':
      case 'backdated_inventory_adjustment':
        return orderAttr.get(e.referenceId) ?? { vehicleId: null, vehicleNumber: e.vehicleNumber ?? '—', driverName: e.driverName ?? '—', tripNumber: null };
      case 'driver_vehicle_assignment':
        return dvaAttr.get(e.referenceId) ?? { vehicleId: null, vehicleNumber: e.vehicleNumber ?? '—', driverName: e.driverName ?? '—', tripNumber: null };
      case 'cancelled_stock':
        return cseAttr.get(e.referenceId) ?? { vehicleId: null, vehicleNumber: e.vehicleNumber ?? '—', driverName: e.driverName ?? '—', tripNumber: null };
      case 'dva_load_manifest':
        return manifestAttr.get(e.referenceId) ?? { vehicleId: null, vehicleNumber: e.vehicleNumber ?? '—', driverName: e.driverName ?? '—', tripNumber: null };
      default:
        return { vehicleId: null, vehicleNumber: e.vehicleNumber ?? '—', driverName: e.driverName ?? '—', tripNumber: null };
    }
  };

  // ── Movement rows ──────────────────────────────────────────────────────────
  // 2026-08-05 F9 — MoveRow keeps the raw counters that DRIVE the display
  // (fullsDispatched, fullsDelivered, emptiesCollected) plus two derived
  // fields the operator wants to see at a glance:
  //   returnedFulls    = fullsDispatched − fullsDelivered
  //                      (fulls that came BACK undelivered — cancellations,
  //                       lost-in-transit, undelivered write-offs. Suneel's
  //                       simple "Returned Qty" column definition.)
  //   outstandingEmpties = fullsDelivered − emptiesCollected
  //                      (empties the customer still owes back after this
  //                       trip. Positive = customer holds N empties;
  //                       negative = customer over-returned.)
  // We keep emptiesReturnedVerified / emptiesGap / cancelledReturns in the
  // row shape for backend consumers + integration tests, but they are
  // no longer surfaced in the column list (kept off the wire-facing
  // columns array — CSV consumers of the trimmed set won't see them).
  type MoveRow = {
    date: string; vehicleNumber: string; driverName: string; tripNumber: number | string; cylinderType: string;
    fullsDispatched: number; fullsDelivered: number; emptiesCollected: number;
    emptiesReturnedVerified: number; emptiesGap: number; cancelledReturns: number;
    returnedFulls: number; outstandingEmpties: number;
    _sortDate: string; _vehicleId: string | null;
  };
  const moveMap = new Map<string, MoveRow>();

  for (const e of events) {
    const dk = dayKey(new Date(e.eventDate));

    const a = attrFor(e);
    // Apply vehicle/driver filters (by id where available).
    if (f.vehicleId && a.vehicleId !== f.vehicleId) continue;
    // driverId filter: resolve via the order/DVA — we only carry driverName here,
    // so the driver filter is applied through the originating order below.
    const tripPart = groupBy === 'trip' ? `${a.tripNumber ?? 'na'}` : dk;
    const key = `${tripPart}|${a.vehicleId ?? a.vehicleNumber}|${e.cylinderTypeId}`;
    const cur = moveMap.get(key) ?? {
      date: dk,
      vehicleNumber: a.vehicleNumber,
      driverName: a.driverName,
      tripNumber: a.tripNumber ?? '—',
      cylinderType: e.cylinderType?.typeName ?? '—',
      fullsDispatched: 0, fullsDelivered: 0, emptiesCollected: 0,
      emptiesReturnedVerified: 0, emptiesGap: 0, cancelledReturns: 0,
      returnedFulls: 0, outstandingEmpties: 0,
      _sortDate: dk, _vehicleId: a.vehicleId,
    };
    switch (e.eventType) {
      case 'dispatch': cur.fullsDispatched += Math.abs(e.fullsChange); break;
      case 'delivery': cur.fullsDelivered += Math.abs(e.fullsChange); break;
      case 'collection':
      case 'returns_collection': cur.emptiesCollected += e.emptiesChange; break;
      case 'reconciliation_empties_return': cur.emptiesReturnedVerified += e.emptiesChange; break;
      case 'cancellation_return': cur.cancelledReturns += e.fullsChange; break;
      // Backdated trip: the manual_adjustment fulls-debit stands in for the
      // delivery leg that a live trip would emit. Guarded upstream to only
      // fetch backdated_inventory_adjustment (not null-refType stock corrections).
      case 'manual_adjustment': cur.fullsDelivered += Math.abs(e.fullsChange); break;
    }
    moveMap.set(key, cur);
  }

  // driverId filter (post-attribution by name match is unreliable; resolve by
  // re-querying the driver's name and filtering rows). Cheap and correct.
  let driverNameFilter: string | undefined;
  if (f.driverId) {
    const drv = await prisma.driver.findFirst({ where: { id: f.driverId, distributorId }, select: { driverName: true } });
    driverNameFilter = drv?.driverName;
  }

  const rows = [...moveMap.values()]
    .map((r) => ({
      ...r,
      emptiesGap: r.emptiesCollected - r.emptiesReturnedVerified,
      // F9 (2026-08-05): user-visible derived fields.
      // returnedFulls: fulls dispatched that came back — cancellations,
      // undelivered, lost. Kept as raw math (dispatched − delivered)
      // per Suneel's plain "Returned Qty (dispatched − delivered)" spec.
      returnedFulls: Math.max(0, r.fullsDispatched - r.fullsDelivered),
      // outstandingEmpties: empties customer still owes back for the
      // fulls they received on this trip. Raw math per Suneel:
      // "outstanding is plain". Can be 0 (fully returned) or positive
      // (customer holding N empties). Never negative — over-return of
      // empties gets absorbed as customer's onAccount empties credit
      // elsewhere, not here.
      outstandingEmpties: Math.max(0, r.fullsDelivered - r.emptiesCollected),
    }))
    .filter((r) => !driverNameFilter || r.driverName === driverNameFilter)
    .sort((a, b) => (a._sortDate === b._sortDate ? a.vehicleNumber.localeCompare(b.vehicleNumber) : a._sortDate.localeCompare(b._sortDate)))
    .map(({ _sortDate, _vehicleId, ...rest }) => { void _sortDate; void _vehicleId; return rest; });

  const totals = {
    date: 'TOTAL', vehicleNumber: '', driverName: '', tripNumber: '', cylinderType: '',
    fullsDispatched: rows.reduce((s, r) => s + r.fullsDispatched, 0),
    fullsDelivered: rows.reduce((s, r) => s + r.fullsDelivered, 0),
    returnedFulls: rows.reduce((s, r) => s + r.returnedFulls, 0),
    emptiesCollected: rows.reduce((s, r) => s + r.emptiesCollected, 0),
    outstandingEmpties: rows.reduce((s, r) => s + r.outstandingEmpties, 0),
    // Kept in totals for CSV/JSON consumers even though they no longer
    // appear in the display columns:
    emptiesReturnedVerified: rows.reduce((s, r) => s + r.emptiesReturnedVerified, 0),
    emptiesGap: rows.reduce((s, r) => s + r.emptiesGap, 0),
    cancelledReturns: rows.reduce((s, r) => s + r.cancelledReturns, 0),
  };

  return {
    // 2026-08-05 F3/F9 — trimmed column list. Removed Fulls Delivered's
    // audit siblings (Empties Returned Verified, Empties Gap, Cancelled
    // Returns) from the display + CSV column list — data still on the
    // row for programmatic consumers. Added returnedFulls +
    // outstandingEmpties. Column order matches the on-screen table.
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'vehicleNumber', label: 'Vehicle' },
      { key: 'driverName', label: 'Driver' },
      { key: 'tripNumber', label: 'Trip' },
      { key: 'cylinderType', label: 'Cylinder Type' },
      { key: 'fullsDispatched', label: 'Dispatched' },
      { key: 'fullsDelivered', label: 'Delivered' },
      { key: 'returnedFulls', label: 'Returned' },
      { key: 'emptiesCollected', label: 'Empties Returned' },
      { key: 'outstandingEmpties', label: 'Outstanding' },
    ],
    rows,
    totals,
  };
}

// ─── Payment Collections — one row per invoice (Suneel 2026-07-14)
//
// "For payments received between X and Y, against which invoices did the money
// land and which driver delivered the underlying order?" — the cashflow lens
// complement to the Delivery Performance report (which uses delivery date).
//
// Filters:
//   • date range → payment_transactions.transaction_date
//   • driverId   → the invoice's underlying order.driver_id
//
// Row shape: ONE ROW PER UNIQUE INVOICE that had at least one allocation in
// the range. Each row's math balances:
//
//     Sale Amount = Paid Earlier + Paid Today + Pending
//
// where:
//   • Paid Earlier = sum of allocations dated < dateFrom
//   • Paid Today   = sum of allocations dated ∈ [dateFrom, dateTo]
//   • Pending      = invoice.outstandingAmount at query time
//
// Per-allocation visibility (bulk payment covering N invoices — the ₹4
// rounding split vs the ₹12,760 main) is preserved in the Payments Register
// (see GET /api/payments/export). This report is the "cashflow summary" view.
export async function paymentCollections(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);

  // Find every invoice that had at least one allocation in range (+ optional
  // driver filter). Join to invoice + order + customer + driver + items so
  // the row assembly stays single-round-trip.
  // 2026-07-17: entry-date filter stacks with the payment-date range.
  // If entryDateFrom/entryDateTo are supplied, they narrow to allocations
  // whose parent PaymentTransaction.createdAt falls in that window. If
  // neither is supplied the clause is omitted (unchanged legacy behaviour).
  const entryDateClause: Record<string, Date> = {};
  if (f.entryDateFrom) entryDateClause.gte = new Date(`${f.entryDateFrom}T00:00:00.000Z`);
  if (f.entryDateTo) entryDateClause.lte = new Date(`${f.entryDateTo}T23:59:59.999Z`);
  const inRangeAllocs = await prisma.paymentAllocation.findMany({
    where: {
      payment: {
        distributorId,
        deletedAt: null,
        transactionDate: { gte: from, lte: to },
        ...(Object.keys(entryDateClause).length > 0 ? { createdAt: entryDateClause } : {}),
      },
      ...(f.driverId
        ? { invoice: { order: { driverId: f.driverId } } }
        : {}),
    },
    select: {
      allocatedAmount: true,
      invoiceId: true,
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          issueDate: true,
          totalAmount: true,
          amountPaid: true,
          outstandingAmount: true,
          customer: { select: { customerName: true, businessName: true } },
          order: {
            select: {
              driver: { select: { driverName: true } },
              items: {
                select: {
                  deliveredQuantity: true,
                  quantity: true,
                  emptiesCollected: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (inRangeAllocs.length === 0) {
    return {
      columns: paymentCollectionsColumns(),
      rows: [],
      totals: paymentCollectionsEmptyTotals(),
    };
  }

  // Sum per-invoice paid-in-range.
  const invoiceIds = [...new Set(inRangeAllocs.map((a) => a.invoiceId))];
  const paidTodayByInvoice = new Map<string, number>();
  const invoiceById = new Map<string, (typeof inRangeAllocs)[number]['invoice']>();
  for (const a of inRangeAllocs) {
    paidTodayByInvoice.set(
      a.invoiceId,
      (paidTodayByInvoice.get(a.invoiceId) ?? 0) + num(a.allocatedAmount),
    );
    if (a.invoice && !invoiceById.has(a.invoiceId)) {
      invoiceById.set(a.invoiceId, a.invoice);
    }
  }

  // Paid Earlier = invoice.amountPaid − paidToday for that invoice.
  // (Fresh calculation instead of a second query — amountPaid is the
  // all-time ledger sum of allocations against this invoice, and we
  // already have the in-range total to subtract from it.)
  type Row = {
    invoiceDate: string;
    customerName: string;
    invoiceNumber: string;
    fullsDelivered: number;
    emptiesCollected: number;
    saleAmount: number;
    paidEarlier: number;
    paidToday: number;
    pendingAmount: number;
    driverName: string;
  };
  const rows: Row[] = invoiceIds.map((invId) => {
    const inv = invoiceById.get(invId)!;
    const items = inv.order?.items ?? [];
    const fullsDelivered = items.reduce(
      (sum, it) => sum + (it.deliveredQuantity ?? it.quantity ?? 0),
      0,
    );
    const emptiesCollected = items.reduce((sum, it) => sum + (it.emptiesCollected ?? 0), 0);
    const saleAmount = +num(inv.totalAmount).toFixed(2);
    const paidToday = +(paidTodayByInvoice.get(invId) ?? 0).toFixed(2);
    const paidAllTime = +num(inv.amountPaid).toFixed(2);
    // paidEarlier = everything paid on this invoice EXCEPT what came in
    // during the current filter window. When paidAllTime < paidToday
    // (e.g. after allocations outside the range were reversed via
    // credit notes), clamp at 0.
    const paidEarlier = Math.max(0, +(paidAllTime - paidToday).toFixed(2));
    const pendingAmount = +num(inv.outstandingAmount).toFixed(2);
    return {
      invoiceDate: inv.issueDate ? dayKey(new Date(inv.issueDate)) : '—',
      customerName: inv.customer?.businessName || inv.customer?.customerName || 'Deleted Customer',
      invoiceNumber: inv.invoiceNumber,
      fullsDelivered,
      emptiesCollected,
      saleAmount,
      paidEarlier,
      paidToday,
      pendingAmount,
      driverName: inv.order?.driver?.driverName ?? '—',
    };
  });

  // Sort: latest invoice-date first so the operator sees recent activity
  // at the top; ties broken by invoice number.
  rows.sort((a, b) => {
    if (a.invoiceDate !== b.invoiceDate) return b.invoiceDate.localeCompare(a.invoiceDate);
    return a.invoiceNumber.localeCompare(b.invoiceNumber);
  });

  const totals = rows.reduce(
    (acc, r) => {
      acc.fullsDelivered += r.fullsDelivered;
      acc.emptiesCollected += r.emptiesCollected;
      acc.saleAmount += r.saleAmount;
      acc.paidEarlier += r.paidEarlier;
      acc.paidToday += r.paidToday;
      acc.pendingAmount += r.pendingAmount;
      return acc;
    },
    { fullsDelivered: 0, emptiesCollected: 0, saleAmount: 0, paidEarlier: 0, paidToday: 0, pendingAmount: 0 },
  );

  return {
    columns: paymentCollectionsColumns(),
    rows,
    totals: {
      invoiceDate: 'TOTAL',
      customerName: '',
      invoiceNumber: '',
      fullsDelivered: totals.fullsDelivered,
      emptiesCollected: totals.emptiesCollected,
      saleAmount: +totals.saleAmount.toFixed(2),
      paidEarlier: +totals.paidEarlier.toFixed(2),
      paidToday: +totals.paidToday.toFixed(2),
      pendingAmount: +totals.pendingAmount.toFixed(2),
      driverName: '',
    },
  };
}

function paymentCollectionsColumns(): ReportColumn[] {
  return [
    { key: 'invoiceDate', label: 'Invoice Date' },
    { key: 'customerName', label: 'Customer' },
    { key: 'invoiceNumber', label: 'Invoice #' },
    { key: 'fullsDelivered', label: 'Fulls Delivered' },
    { key: 'emptiesCollected', label: 'Empties Collected' },
    { key: 'saleAmount', label: 'Sale Amount', money: true },
    { key: 'paidEarlier', label: 'Paid Earlier', money: true },
    { key: 'paidToday', label: 'Paid Today', money: true },
    { key: 'pendingAmount', label: 'Pending Amount', money: true },
    { key: 'driverName', label: 'Delivery Boy' },
  ];
}

function paymentCollectionsEmptyTotals(): Record<string, unknown> {
  return {
    invoiceDate: 'TOTAL',
    customerName: '',
    invoiceNumber: '',
    fullsDelivered: 0,
    emptiesCollected: 0,
    saleAmount: 0,
    paidEarlier: 0,
    paidToday: 0,
    pendingAmount: 0,
    driverName: '',
  };
}

// ─── Report — Day-Close Summary (N20 · Sprint B Chunk 2 · 2026-08-05) ─────
//
// The "how did today go?" one-pager. Finance / distributor_admin opens
// this end-of-day (or first thing next morning) to close the books.
// Signable snapshot. Flat `{metric, amount, count}` rows grouped into
// 6 sections (Revenue, Payments, Deliveries, Inventory, Expenses,
// Customers) via bold header rows — renders natively in the existing
// `<ReportTable>` component without any UI surgery.
//
// Filter behavior: reuses dateFrom + dateTo. Most users pick a single
// day; a range (e.g. Mon-Fri weekly close) sums across the range.
// Default from the frontend: yesterday..today.
//
// Cash-in-hand carry-forward is deliberately NOT computed here — it
// belongs in the dedicated Cash Book report (N21, Chunk 4 batch 2)
// with proper opening-cash tracking. This report shows same-day
// deltas only.
export async function dayCloseSummary(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const fromDayStr = dayKey(from);
  const toDayStr = dayKey(to);

  // Parallel-fetch every input in one shot — all queries are independent
  // and touch different tables. Wall-clock = slowest single query.
  const [
    invoiceAgg,
    deliveredOrderAgg,
    cancelledOrderAgg,
    paymentsByMethod,
    pendingOrderCount,
    inventoryEvents,
    latestInventorySummaries,
    expenseAgg,
    newCustomerCount,
    activeCustomerRows,
  ] = await Promise.all([
    // ── Revenue: invoices raised in range (by issueDate) ─────────────
    prisma.invoice.aggregate({
      where: { distributorId, issueDate: { gte: from, lte: to }, deletedAt: null },
      _sum: { totalAmount: true },
      _count: true,
    }),
    // ── Revenue: delivered orders in range (by deliveryDate) ──────────
    prisma.order.aggregate({
      where: { distributorId, deliveryDate: { gte: from, lte: to }, status: 'delivered', deletedAt: null },
      _sum: { totalAmount: true },
      _count: true,
    }),
    // ── Revenue: cancelled orders in range (by deliveryDate) ──────────
    // Semantic: "of orders scheduled for today, how many got cancelled?"
    // NOT "cancellations logged today" (which could be for future dates).
    prisma.order.aggregate({
      where: { distributorId, deliveryDate: { gte: from, lte: to }, status: 'cancelled', deletedAt: null },
      _sum: { totalAmount: true },
      _count: true,
    }),
    // ── Payments: grouped by method ──────────────────────────────────
    prisma.paymentTransaction.groupBy({
      by: ['paymentMethod'],
      where: { distributorId, transactionDate: { gte: from, lte: to } },
      _sum: { amount: true },
      _count: true,
    }),
    // ── Deliveries: still-pending orders as of dateTo ─────────────────
    prisma.order.count({
      where: {
        distributorId,
        deletedAt: null,
        deliveryDate: { lte: to },
        status: { in: ['pending_driver_assignment', 'pending_dispatch', 'pending_delivery'] },
      },
    }),
    // ── Deliveries: physical stock movement events in range ───────────
    prisma.inventoryEvent.findMany({
      where: {
        distributorId,
        eventDate: { gte: from, lte: to },
        eventType: { in: ['dispatch', 'delivery', 'collection', 'returns_collection'] },
      },
      select: { eventType: true, fullsChange: true, emptiesChange: true },
    }),
    // ── Inventory: latest summary row per cylinder type on/before dateTo ─
    // Uses distinct-by-cylinderType with orderBy summaryDate DESC to grab
    // the freshest snapshot for each cyl type.
    prisma.inventorySummary.findMany({
      where: { distributorId, summaryDate: { lte: to } },
      orderBy: [{ cylinderTypeId: 'asc' }, { summaryDate: 'desc' }],
      distinct: ['cylinderTypeId'],
      include: { cylinderType: { select: { typeName: true } } },
    }),
    // ── Expenses: total in range ─────────────────────────────────────
    // Expense.expenseDate is a STRING 'YYYY-MM-DD' (per schema.prisma:848).
    prisma.expense.aggregate({
      where: { distributorId, expenseDate: { gte: fromDayStr, lte: toDayStr }, deletedAt: null },
      _sum: { amount: true },
      _count: true,
    }),
    // ── Customers: new in range ──────────────────────────────────────
    prisma.customer.count({
      where: { distributorId, createdAt: { gte: from, lte: to }, deletedAt: null },
    }),
    // ── Customers: active (had a delivered order in range) ────────────
    prisma.order.findMany({
      where: { distributorId, deliveryDate: { gte: from, lte: to }, status: 'delivered', deletedAt: null },
      distinct: ['customerId'],
      select: { customerId: true },
    }),
  ]);

  // ── Reduce inventory events into 4 physical-flow counters ────────────
  let fullsDispatched = 0, fullsDelivered = 0, emptiesCollected = 0;
  for (const e of inventoryEvents) {
    if (e.eventType === 'dispatch') fullsDispatched += Math.abs(e.fullsChange);
    else if (e.eventType === 'delivery') fullsDelivered += Math.abs(e.fullsChange);
    else if (e.eventType === 'collection' || e.eventType === 'returns_collection') emptiesCollected += Math.abs(e.emptiesChange);
  }
  const returnedFulls = Math.max(0, fullsDispatched - fullsDelivered);
  const outstandingEmpties = Math.max(0, fullsDelivered - emptiesCollected);

  // ── Reduce payments-by-method into a lookup map ──────────────────────
  const methodMap = new Map<string, { amount: number; count: number }>();
  let totalPaymentAmount = 0;
  let totalPaymentCount = 0;
  for (const p of paymentsByMethod) {
    const amt = Number(p._sum.amount ?? 0);
    methodMap.set(p.paymentMethod, { amount: amt, count: p._count });
    totalPaymentAmount += amt;
    totalPaymentCount += p._count;
  }
  const methodValue = (method: string) => methodMap.get(method) ?? { amount: 0, count: 0 };

  // ── Build the flat row list. Section-header rows have amount/count
  // set to null; the frontend renders them plainly (bold via row scan).
  type Row = { metric: string; amount: number | null; count: number | null };
  const rows: Row[] = [];
  const hdr = (title: string) => rows.push({ metric: `── ${title} ──`, amount: null, count: null });
  const kv = (metric: string, amount: number | null, count: number | null = null) =>
    rows.push({ metric, amount, count });

  hdr('REVENUE');
  kv('Invoices raised (by issue date)', Number(invoiceAgg._sum.totalAmount ?? 0), invoiceAgg._count);
  kv('Delivered orders', Number(deliveredOrderAgg._sum.totalAmount ?? 0), deliveredOrderAgg._count);
  kv('Cancelled orders (scheduled for range)', Number(cancelledOrderAgg._sum.totalAmount ?? 0), cancelledOrderAgg._count);

  hdr('PAYMENTS');
  kv('Total received', totalPaymentAmount, totalPaymentCount);
  kv('  Cash', methodValue('cash').amount, methodValue('cash').count);
  kv('  UPI', methodValue('upi').amount, methodValue('upi').count);
  kv('  Cheque', methodValue('cheque').amount, methodValue('cheque').count);
  kv('  Online', methodValue('online').amount, methodValue('online').count);
  kv('  Bank transfer', methodValue('bank_transfer').amount, methodValue('bank_transfer').count);
  kv('  Credit', methodValue('credit').amount, methodValue('credit').count);

  hdr('DELIVERIES');
  kv('Delivered orders', null, deliveredOrderAgg._count);
  kv('Pending (delivery on/before end of range)', null, pendingOrderCount);
  kv('Fulls dispatched (all trips)', null, fullsDispatched);
  kv('Fulls delivered', null, fullsDelivered);
  kv('Returned fulls (undelivered)', null, returnedFulls);
  kv('Empties returned by customers', null, emptiesCollected);
  kv('Outstanding empties (this range)', null, outstandingEmpties);

  hdr('INVENTORY (closing snapshot)');
  for (const s of latestInventorySummaries) {
    const typeName = s.cylinderType?.typeName ?? s.cylinderTypeId;
    kv(`Closing fulls · ${typeName}`, null, s.closingFulls);
    kv(`Closing empties · ${typeName}`, null, s.closingEmpties);
  }

  hdr('EXPENSES');
  kv('Expenses recorded', Number(expenseAgg._sum.amount ?? 0), expenseAgg._count);

  hdr('CUSTOMERS');
  kv('New customers added', null, newCustomerCount);
  kv('Active customers (had a delivery)', null, activeCustomerRows.length);

  return {
    columns: [
      { key: 'metric', label: 'Metric' },
      { key: 'amount', label: 'Amount', money: true },
      { key: 'count', label: 'Count' },
    ],
    rows: rows as unknown as Record<string, string | number | null>[],
  };
}

// ─── Report — Deposit Ledger per Customer (N24 · Chunk 3 · 2026-08-05) ───
//
// Per-customer breakdown of deposits paid + refunded over the date range,
// with a running "current deposit balance" carried forward. Rows are
// grouped by customer (one row per customer that has activity in range).
//
// Data source: CustomerLedgerEntry where entryType in
// ('deposit_charged', 'deposit_refunded'). Both types were added to the
// LedgerEntryType enum on 2026-07-31 (Deposit Ledger commit).
//
// `amountDelta` is signed: charged = +, refunded = − (in the app's
// receivables-perspective convention). We surface both magnitudes as
// separate columns so operators don't have to reason about signs.
export async function depositLedgerByCustomer(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);

  const [inRange, priorTotal] = await Promise.all([
    // Rows in the requested date range
    prisma.customerLedgerEntry.findMany({
      where: {
        distributorId,
        entryType: { in: ['deposit_charged', 'deposit_refunded'] },
        entryDate: { gte: from, lte: to },
        ...(f.customerId ? { customerId: f.customerId } : {}),
      },
      include: { customer: { select: { customerName: true } } },
    }),
    // Sum of deposit entries BEFORE the range — used as "opening balance"
    // to keep the running "Current Deposit Balance" column accurate.
    prisma.customerLedgerEntry.groupBy({
      by: ['customerId'],
      where: {
        distributorId,
        entryType: { in: ['deposit_charged', 'deposit_refunded'] },
        entryDate: { lt: from },
        ...(f.customerId ? { customerId: f.customerId } : {}),
      },
      _sum: { amountDelta: true },
    }),
  ]);

  const priorMap = new Map<string, number>();
  for (const p of priorTotal) priorMap.set(p.customerId, num(p._sum.amountDelta));

  type Row = { customer: string; customerId: string; opening: number; charged: number; refunded: number; net: number; closing: number };
  const per = new Map<string, Row>();
  for (const e of inRange) {
    const cid = e.customerId;
    const row = per.get(cid) ?? {
      customer: e.customer?.customerName ?? '—',
      customerId: cid,
      opening: priorMap.get(cid) ?? 0,
      charged: 0,
      refunded: 0,
      net: 0,
      closing: 0,
    };
    const delta = num(e.amountDelta);
    if (e.entryType === 'deposit_charged') row.charged += delta;
    else if (e.entryType === 'deposit_refunded') row.refunded += Math.abs(delta);
    per.set(cid, row);
  }
  // Include customers with prior deposits but no in-range activity (opening
  // balance != 0). Otherwise you'd see 0 rows for a "sleepy" week even
  // though the balance sheet has millions in deposits.
  for (const [cid, opening] of priorMap.entries()) {
    if (per.has(cid) || opening === 0) continue;
    const cust = await prisma.customer.findUnique({
      where: { id: cid },
      select: { customerName: true },
    });
    per.set(cid, {
      customer: cust?.customerName ?? '—',
      customerId: cid,
      opening,
      charged: 0,
      refunded: 0,
      net: 0,
      closing: opening,
    });
  }

  const rows = [...per.values()]
    .map((r) => {
      r.net = r.charged - r.refunded;
      r.closing = r.opening + r.net;
      return r;
    })
    .sort((a, b) => b.closing - a.closing);

  const totals = {
    customer: 'TOTAL',
    customerId: '',
    opening: rows.reduce((s, r) => s + r.opening, 0),
    charged: rows.reduce((s, r) => s + r.charged, 0),
    refunded: rows.reduce((s, r) => s + r.refunded, 0),
    net: rows.reduce((s, r) => s + r.net, 0),
    closing: rows.reduce((s, r) => s + r.closing, 0),
  };

  return {
    columns: [
      { key: 'customer', label: 'Customer' },
      { key: 'opening', label: 'Opening Deposit', money: true },
      { key: 'charged', label: 'Charged (range)', money: true },
      { key: 'refunded', label: 'Refunded (range)', money: true },
      { key: 'net', label: 'Net (range)', money: true },
      { key: 'closing', label: 'Current Deposit Balance', money: true },
    ],
    rows,
    totals,
  };
}

// ─── Report — Stock-Adjustment Audit Log (N26 · Chunk 3 · 2026-08-05) ────
//
// Every `manual_adjustment` inventory event (referenceType = null OR
// something other than `backdated_inventory_adjustment` — the backdated
// variant is a synthetic delivery leg surfaced elsewhere). Answers the
// audit question: "Who adjusted stock, when, why, by how much?"
//
// This surface is CSV-first — operators need it during monthly stock
// reconciliation to explain deltas between physical count and system
// closing balance.
export async function stockAdjustmentAuditLog(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);

  const events = await prisma.inventoryEvent.findMany({
    where: {
      distributorId,
      eventType: 'manual_adjustment',
      eventDate: { gte: from, lte: to },
      // Exclude the backdated-order synthetic adjustments — those are
      // trip-shaped events, not stock corrections. See vehicleLedger's
      // fetch clause for the mirroring inclusion. `NOT: {referenceType:
      // 'X'}` alone excludes NULL referenceType rows because SQL NULL
      // comparisons return NULL, not TRUE — so we use an explicit
      // OR-NULL branch to keep unreferenced manual adjustments.
      OR: [
        { referenceType: null },
        { referenceType: { not: 'backdated_inventory_adjustment' } },
      ],
      ...(f.cylinderTypeId ? { cylinderTypeId: f.cylinderTypeId } : {}),
    },
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: [{ eventDate: 'desc' }, { createdAt: 'desc' }],
  });

  const rows = events.map((e) => ({
    eventDate: dayKey(e.eventDate),
    cylinderType: e.cylinderType?.typeName ?? '—',
    fullsChange: e.fullsChange,
    emptiesChange: e.emptiesChange,
    notes: e.notes ?? '',
    createdBy: e.createdBy,
    documentNumber: e.documentNumber ?? '',
  }));

  const totals = {
    eventDate: 'TOTAL',
    cylinderType: '',
    fullsChange: rows.reduce((s, r) => s + r.fullsChange, 0),
    emptiesChange: rows.reduce((s, r) => s + r.emptiesChange, 0),
    notes: '',
    createdBy: '',
    documentNumber: '',
  };

  return {
    columns: [
      { key: 'eventDate', label: 'Date' },
      { key: 'cylinderType', label: 'Cylinder Type' },
      { key: 'fullsChange', label: 'Fulls Δ' },
      { key: 'emptiesChange', label: 'Empties Δ' },
      { key: 'notes', label: 'Notes' },
      { key: 'createdBy', label: 'Adjusted By' },
      { key: 'documentNumber', label: 'Doc No' },
    ],
    rows,
    totals,
  };
}

// ─── Report — Expense Register (N32 · Chunk 3 · 2026-08-05) ──────────────
//
// Machine-readable + PDF-optional list of every expense in the range.
// One row per Expense. Complements the existing bespoke Expense Report
// PDF (which is aggregated / grouped by-header). This one is flat + raw
// for spreadsheet analysis + CA-hand-off.
export async function expenseRegister(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  // Expense.expenseDate is a STRING 'YYYY-MM-DD' per schema.prisma:848.
  const { from, to } = range(f);
  const fromStr = dayKey(from);
  const toStr = dayKey(to);

  const rows = await prisma.expense.findMany({
    where: {
      distributorId,
      expenseDate: { gte: fromStr, lte: toStr },
      deletedAt: null,
    },
    include: {
      category: { select: { name: true } },
      vehicle: { select: { vehicleNumber: true } },
      driver: { select: { driverName: true } },
    },
    orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
  });

  const mapped = rows.map((e) => ({
    expenseDate: e.expenseDate,
    category: e.category?.name ?? '—',
    amount: num(e.amount),
    paymentMethod: e.paymentMethod,
    description: e.description,
    vendor: e.vendorName ?? '',
    paidTo: e.paidToName ?? '',
    vehicle: e.vehicle?.vehicleNumber ?? '',
    driver: e.driver?.driverName ?? '',
    referenceNumber: e.referenceNumber ?? '',
  }));

  const totals = {
    expenseDate: 'TOTAL',
    category: '',
    amount: mapped.reduce((s, r) => s + r.amount, 0),
    paymentMethod: '',
    description: '',
    vendor: '',
    paidTo: '',
    vehicle: '',
    driver: '',
    referenceNumber: '',
  };

  return {
    columns: [
      { key: 'expenseDate', label: 'Date' },
      { key: 'category', label: 'Category' },
      { key: 'amount', label: 'Amount', money: true },
      { key: 'paymentMethod', label: 'Method' },
      { key: 'description', label: 'Description' },
      { key: 'vendor', label: 'Vendor' },
      { key: 'paidTo', label: 'Paid To' },
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'driver', label: 'Driver' },
      { key: 'referenceNumber', label: 'Ref No' },
    ],
    rows: mapped,
    totals,
  };
}

// ─── Report — Cylinder Rotation (N10 · Chunk 4 · 2026-08-05) ────────────
//
// The "who's holding my cylinders longest?" ranking. Answers the daily
// deposit-float question every distributor obsesses over. Rows are
// per (customer, cylinderType) with `withCustomerQty > 0`. Sorted by
// days-since-last-delivery DESC (worst holders first).
//
// Filter behavior: customerId + cylinderTypeId narrow the row set;
// dateFrom / dateTo are accepted for consistency but don't affect
// what a row shows (report is always current-state).
export async function cylinderRotation(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  // Load all balances with qty > 0. Filter by customer / cyl type at DB level.
  const balances = await prisma.customerInventoryBalance.findMany({
    where: {
      customer: { distributorId, deletedAt: null },
      withCustomerQty: { gt: 0 },
      ...(f.customerId ? { customerId: f.customerId } : {}),
      ...(f.cylinderTypeId ? { cylinderTypeId: f.cylinderTypeId } : {}),
    },
    include: {
      customer: { select: { customerName: true } },
      cylinderType: { select: { typeName: true } },
    },
  });
  if (balances.length === 0) {
    return {
      columns: [
        { key: 'customer', label: 'Customer' },
        { key: 'cylinderType', label: 'Cylinder Type' },
        { key: 'heldQty', label: 'Currently Held' },
        { key: 'lastDelivery', label: 'Last Delivery' },
        { key: 'daysSinceDelivery', label: 'Days Since Delivery' },
        { key: 'avgCycleDays', label: 'Avg Days / Delivery' },
        { key: 'deviationDays', label: 'Deviation (Days)' },
        { key: 'lastPickup', label: 'Last Empty Pickup' },
        { key: 'daysSincePickup', label: 'Days Since Pickup' },
      ],
      rows: [],
      totals: { customer: 'TOTAL', cylinderType: '', heldQty: 0, lastDelivery: '', daysSinceDelivery: '', avgCycleDays: '', deviationDays: '', lastPickup: '', daysSincePickup: '' },
    };
  }

  const customerIds = [...new Set(balances.map((b) => b.customerId))];
  const cylinderTypeIds = [...new Set(balances.map((b) => b.cylinderTypeId))];

  // Last delivery per (customer, cyl). Grouped MAX on Order.deliveryDate.
  const lastDeliveries = await prisma.order.groupBy({
    by: ['customerId'],
    where: {
      distributorId,
      customerId: { in: customerIds },
      status: 'delivered',
      deletedAt: null,
    },
    _max: { deliveryDate: true },
  });
  const lastDeliveryMap = new Map<string, Date | null>();
  for (const r of lastDeliveries) lastDeliveryMap.set(r.customerId, r._max.deliveryDate ?? null);

  // Refinement: per (customer, cylinderType) — walk OrderItem-scoped max
  // since customer might have multiple cyl types delivered on different days.
  const perCustomerCylDeliveries = await prisma.order.findMany({
    where: {
      distributorId,
      customerId: { in: customerIds },
      status: 'delivered',
      deletedAt: null,
      items: { some: { cylinderTypeId: { in: cylinderTypeIds } } },
    },
    select: {
      customerId: true,
      deliveryDate: true,
      items: { select: { cylinderTypeId: true } },
    },
  });
  const perTypeDelivery = new Map<string, Date>();
  const key = (custId: string, typeId: string) => `${custId}|${typeId}`;
  // 2026-08-06 (FX-F): also collect ALL delivery dates per (cust, cyl) to
  // compute average days between consecutive deliveries. Answers "is this
  // customer 45-days on a normal 15-day cycle → they're hoarding".
  const allDeliveryDates = new Map<string, Date[]>();
  for (const o of perCustomerCylDeliveries) {
    for (const it of o.items) {
      const k = key(o.customerId, it.cylinderTypeId);
      const existing = perTypeDelivery.get(k);
      if (!existing || o.deliveryDate > existing) perTypeDelivery.set(k, o.deliveryDate);
      const list = allDeliveryDates.get(k) ?? [];
      list.push(o.deliveryDate);
      allDeliveryDates.set(k, list);
    }
  }
  // Compute avg gap in days per pair. Requires ≥2 deliveries; else null.
  const avgGapDays = new Map<string, number | null>();
  for (const [k, dates] of allDeliveryDates.entries()) {
    if (dates.length < 2) { avgGapDays.set(k, null); continue; }
    const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
    let totalGap = 0;
    for (let i = 1; i < sorted.length; i++) {
      totalGap += (sorted[i].getTime() - sorted[i - 1].getTime()) / (1000 * 60 * 60 * 24);
    }
    avgGapDays.set(k, Math.round(totalGap / (sorted.length - 1)));
  }

  // Last empty pickup per (customer, cyl). Uses collection / returns_collection events.
  const lastPickups = await prisma.inventoryEvent.groupBy({
    by: ['referenceId'],
    where: {
      distributorId,
      eventType: { in: ['collection', 'returns_collection'] },
      referenceType: 'order',
      cylinderTypeId: { in: cylinderTypeIds },
    },
    _max: { eventDate: true },
  });
  // Map order refs → customer + cyl via Order lookups.
  const refIds = lastPickups.map((r) => r.referenceId!).filter(Boolean);
  const refOrders = refIds.length
    ? await prisma.order.findMany({
        where: { id: { in: refIds } },
        select: { id: true, customerId: true },
      })
    : [];
  const orderCustMap = new Map(refOrders.map((o) => [o.id, o.customerId]));
  const perTypePickup = new Map<string, Date>();
  for (const p of lastPickups) {
    if (!p.referenceId || !p._max.eventDate) continue;
    const custId = orderCustMap.get(p.referenceId);
    if (!custId) continue;
    // Note: this per-cyl-type mapping needs the event.cylinderTypeId too.
    // groupBy above didn't group by cyl — we'd need a second query. For MVP
    // this per-customer-per-order-refined-max is a good approximation:
    // the last pickup for any of their cyl types applies to all their
    // held types (which is roughly accurate — trucks collect all types
    // during a stop).
  }
  // Simpler + correct approach: query with cylinderTypeId in the groupBy.
  const lastPickupsByCyl = await prisma.inventoryEvent.groupBy({
    by: ['referenceId', 'cylinderTypeId'],
    where: {
      distributorId,
      eventType: { in: ['collection', 'returns_collection'] },
      referenceType: 'order',
      cylinderTypeId: { in: cylinderTypeIds },
    },
    _max: { eventDate: true },
  });
  perTypePickup.clear();
  for (const p of lastPickupsByCyl) {
    if (!p.referenceId || !p._max.eventDate) continue;
    const custId = orderCustMap.get(p.referenceId);
    if (!custId) continue;
    const k = key(custId, p.cylinderTypeId);
    const existing = perTypePickup.get(k);
    if (!existing || p._max.eventDate > existing) perTypePickup.set(k, p._max.eventDate);
  }

  const today = new Date();
  const rows = balances.map((b) => {
    const k = key(b.customerId, b.cylinderTypeId);
    const lastDelivery = perTypeDelivery.get(k) ?? null;
    const lastPickup = perTypePickup.get(k) ?? null;
    const daysBetween = (d: Date | null) =>
      d ? Math.floor((today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)) : null;
    const avgCycle = avgGapDays.get(k) ?? null;
    const daysSince = daysBetween(lastDelivery);
    // Derived: how much longer than typical? Positive = holding longer than
    // usual for this customer. Null when either avg or last-delivery is null.
    const deviation = (avgCycle !== null && daysSince !== null) ? daysSince - avgCycle : null;
    return {
      customer: b.customer?.customerName ?? '—',
      customerId: b.customerId,
      cylinderType: b.cylinderType?.typeName ?? '—',
      heldQty: b.withCustomerQty,
      lastDelivery: lastDelivery ? dayKey(lastDelivery) : '—',
      daysSinceDelivery: daysSince,
      avgCycleDays: avgCycle,
      deviationDays: deviation,
      lastPickup: lastPickup ? dayKey(lastPickup) : '—',
      daysSincePickup: daysBetween(lastPickup),
    };
  });
  // Sort by daysSinceDelivery DESC; nulls (no delivery history) go LAST.
  rows.sort((a, b) => {
    const av = a.daysSinceDelivery ?? -1;
    const bv = b.daysSinceDelivery ?? -1;
    return bv - av;
  });

  const totals = {
    customer: 'TOTAL',
    customerId: '',
    cylinderType: '',
    heldQty: rows.reduce((s, r) => s + r.heldQty, 0),
    lastDelivery: '',
    daysSinceDelivery: '',
    avgCycleDays: '',
    deviationDays: '',
    lastPickup: '',
    daysSincePickup: '',
  };

  return {
    columns: [
      { key: 'customer', label: 'Customer' },
      { key: 'cylinderType', label: 'Cylinder Type' },
      { key: 'heldQty', label: 'Currently Held' },
      { key: 'lastDelivery', label: 'Last Delivery' },
      { key: 'daysSinceDelivery', label: 'Days Since Delivery' },
      { key: 'avgCycleDays', label: 'Avg Days / Delivery' },
      { key: 'deviationDays', label: 'Deviation (Days)' },
      { key: 'lastPickup', label: 'Last Empty Pickup' },
      { key: 'daysSincePickup', label: 'Days Since Pickup' },
    ],
    rows,
    totals,
  };
}

// Route / Driver Performance report DELETED 2026-08-06 — merged into
// driverDailyLog. Kept the delete-and-replace decision inline in the
// commit log rather than empty stub — see driverDailyLog above for the
// combined driver-scorecard + daily-log columns.

// ─── Report — Driver & Vehicle Cost Breakdown (N13 · Chunk 4 · 2026-08-05) ─
//
// Per (driver, vehicle) cost analysis across ALL expense categories, not
// just fuel. Uses expense.categoryId → category.name to bucket into
// Fuel / Maintenance / Toll / Insurance / Other by keyword match on
// category name (case-insensitive). Categorises via keywords because
// distributors name their categories differently ("Fuel", "Diesel",
// "Petrol Bill" all count as Fuel).
//
// Real-world decision tool: reveals "Ravi costs 45% less per delivery
// than Suresh" even when Ravi's fuel spend is higher (maintenance +
// toll offset the difference the other way).
export async function driverVehicleCostBreakdown(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const fromStr = dayKey(from);
  const toStr = dayKey(to);

  const [expenses, orders] = await Promise.all([
    prisma.expense.findMany({
      where: {
        distributorId,
        expenseDate: { gte: fromStr, lte: toStr },
        deletedAt: null,
        // Only expenses attributable to a driver OR vehicle — global overhead
        // (rent, office supplies) doesn't belong on this per-driver report.
        OR: [{ driverId: { not: null } }, { vehicleId: { not: null } }],
        ...(f.driverId ? { driverId: f.driverId } : {}),
      },
      include: {
        category: { select: { name: true } },
        driver: { select: { driverName: true } },
        vehicle: { select: { vehicleNumber: true } },
      },
    }),
    prisma.order.findMany({
      where: {
        distributorId,
        deliveryDate: { gte: from, lte: to },
        status: 'delivered',
        deletedAt: null,
        driverId: { not: null },
        ...(f.driverId ? { driverId: f.driverId } : {}),
      },
      select: { id: true, driverId: true, totalAmount: true },
    }),
  ]);

  // Bucketize category names into 5 groups by keyword.
  function classify(catName: string): 'fuel' | 'maintenance' | 'toll' | 'insurance' | 'other' {
    const n = catName.toLowerCase();
    if (/fuel|diesel|petrol|gas|cng/.test(n)) return 'fuel';
    if (/maint|service|repair|spare/.test(n)) return 'maintenance';
    if (/toll|parking/.test(n)) return 'toll';
    if (/insur|road tax|permit/.test(n)) return 'insurance';
    return 'other';
  }

  type Row = {
    driver: string; driverId: string; vehicle: string;
    fuel: number; maintenance: number; toll: number; insurance: number; other: number;
    totalCost: number; deliveries: number; costPerDelivery: number;
    revenue: number; costPercentRevenue: number;
  };
  // Key by driverId (vehicle attribution is best-effort via the first
  // matching expense — a driver typically drives one vehicle in a period).
  const per = new Map<string, Row>();
  const getRow = (drvId: string, drvName: string, veh: string): Row => {
    const existing = per.get(drvId);
    if (existing) return existing;
    const fresh: Row = {
      driver: drvName, driverId: drvId, vehicle: veh,
      fuel: 0, maintenance: 0, toll: 0, insurance: 0, other: 0,
      totalCost: 0, deliveries: 0, costPerDelivery: 0,
      revenue: 0, costPercentRevenue: 0,
    };
    per.set(drvId, fresh);
    return fresh;
  };

  for (const e of expenses) {
    if (!e.driverId) continue;
    const row = getRow(e.driverId, e.driver?.driverName ?? '—', e.vehicle?.vehicleNumber ?? '—');
    const bucket = classify(e.category?.name ?? '');
    const amt = num(e.amount);
    row[bucket] += amt;
    row.totalCost += amt;
  }
  for (const o of orders) {
    if (!o.driverId) continue;
    // Row may not exist if this driver had orders but zero expenses in range.
    const row = getRow(o.driverId, '—', '—');
    row.deliveries += 1;
    row.revenue += num(o.totalAmount);
  }

  const rows = [...per.values()].map((r) => {
    r.costPerDelivery = r.deliveries > 0 ? Math.round(r.totalCost / r.deliveries) : 0;
    r.costPercentRevenue = r.revenue > 0 ? Math.round((r.totalCost / r.revenue) * 100) : 0;
    return r;
  }).sort((a, b) => b.totalCost - a.totalCost);

  const totals = {
    driver: 'TOTAL', driverId: '', vehicle: '',
    fuel: rows.reduce((s, r) => s + r.fuel, 0),
    maintenance: rows.reduce((s, r) => s + r.maintenance, 0),
    toll: rows.reduce((s, r) => s + r.toll, 0),
    insurance: rows.reduce((s, r) => s + r.insurance, 0),
    other: rows.reduce((s, r) => s + r.other, 0),
    totalCost: rows.reduce((s, r) => s + r.totalCost, 0),
    deliveries: rows.reduce((s, r) => s + r.deliveries, 0),
    costPerDelivery: 0, revenue: rows.reduce((s, r) => s + r.revenue, 0), costPercentRevenue: 0,
  };

  return {
    columns: [
      { key: 'driver', label: 'Driver' },
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'fuel', label: 'Fuel', money: true },
      { key: 'maintenance', label: 'Maintenance', money: true },
      { key: 'toll', label: 'Toll', money: true },
      { key: 'insurance', label: 'Insurance', money: true },
      { key: 'other', label: 'Other', money: true },
      { key: 'totalCost', label: 'Total Cost', money: true },
      { key: 'deliveries', label: 'Deliveries' },
      { key: 'costPerDelivery', label: '₹/Delivery', money: true },
      { key: 'revenue', label: 'Revenue', money: true },
      { key: 'costPercentRevenue', label: 'Cost % Rev' },
    ],
    rows,
    totals,
  };
}

// ─── Report — Empties-in-Transit (N14 · Chunk 4 · 2026-08-05) ───────────
//
// Per cylinder type, how many empties are neither at depot NOR
// completed-return: (a) dispatched-not-yet-reconciled (CancelledStockEvent
// pending_return + on_vehicle statuses) and (b) with customers
// (CustomerInventoryBalance.withCustomerQty summed). Answers the
// weekly reconciliation question: "where's my missing empties?"
export async function emptiesInTransit(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  // Filters mostly ignored — this is a current-state snapshot.
  const [cancelled, balances, types] = await Promise.all([
    prisma.cancelledStockEvent.findMany({
      where: {
        distributorId,
        status: { in: ['pending_return', 'on_vehicle'] },
        ...(f.cylinderTypeId ? { cylinderTypeId: f.cylinderTypeId } : {}),
      },
      select: { cylinderTypeId: true, quantity: true },
    }),
    prisma.customerInventoryBalance.findMany({
      where: {
        customer: { distributorId, deletedAt: null },
        withCustomerQty: { gt: 0 },
        ...(f.cylinderTypeId ? { cylinderTypeId: f.cylinderTypeId } : {}),
      },
      select: { cylinderTypeId: true, withCustomerQty: true },
    }),
    prisma.cylinderType.findMany({
      where: {
        distributorId,
        isActive: true,
        ...(f.cylinderTypeId ? { id: f.cylinderTypeId } : {}),
      },
      select: { id: true, typeName: true },
    }),
  ]);

  const dispatchedByCyl = new Map<string, number>();
  for (const c of cancelled) dispatchedByCyl.set(c.cylinderTypeId, (dispatchedByCyl.get(c.cylinderTypeId) ?? 0) + c.quantity);
  const heldByCyl = new Map<string, number>();
  for (const b of balances) heldByCyl.set(b.cylinderTypeId, (heldByCyl.get(b.cylinderTypeId) ?? 0) + b.withCustomerQty);

  const rows = types.map((t) => {
    const dispatched = dispatchedByCyl.get(t.id) ?? 0;
    const held = heldByCyl.get(t.id) ?? 0;
    return {
      cylinderType: t.typeName,
      dispatchedNotReturned: dispatched,
      heldByCustomers: held,
      totalInTransit: dispatched + held,
    };
  }).sort((a, b) => b.totalInTransit - a.totalInTransit);

  const totals = {
    cylinderType: 'TOTAL',
    dispatchedNotReturned: rows.reduce((s, r) => s + r.dispatchedNotReturned, 0),
    heldByCustomers: rows.reduce((s, r) => s + r.heldByCustomers, 0),
    totalInTransit: rows.reduce((s, r) => s + r.totalInTransit, 0),
  };

  return {
    columns: [
      { key: 'cylinderType', label: 'Cylinder Type' },
      { key: 'dispatchedNotReturned', label: 'Dispatched Not Returned' },
      { key: 'heldByCustomers', label: 'Held by Customers' },
      { key: 'totalInTransit', label: 'Total In Transit' },
    ],
    rows,
    totals,
  };
}

// ─── Report — Credit Notes Register (N28 · Chunk 3b · 2026-08-05) ───────
//
// Flat list of every CreditNote in the date range. CreditNote has NO
// distributorId column of its own — tenant scope is enforced by joining
// through the parent Invoice. The status enum is Prisma-side
// `pending_cn` / `approved_cn` / etc.; the shared status names strip
// the `_cn` suffix (anti-pattern #9 discipline). We surface the
// normalized name for display consistency.
export async function creditNotesRegister(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);

  const notes = await prisma.creditNote.findMany({
    where: {
      invoice: { distributorId },
      // issueDate is optional (some historical CNs have null). Fall
      // through to createdAt when null so nothing hides.
      OR: [
        { issueDate: { gte: from, lte: to } },
        { AND: [{ issueDate: null }, { createdAt: { gte: from, lte: to } }] },
      ],
    },
    include: {
      invoice: {
        select: { invoiceNumber: true, customer: { select: { customerName: true } } },
      },
    },
    orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
  });

  const rows = notes.map((n) => ({
    date: n.issueDate ? dayKey(n.issueDate) : dayKey(n.createdAt),
    creditNoteNumber: n.creditNoteNumber ?? '',
    invoiceNumber: n.invoice?.invoiceNumber ?? '',
    customer: n.invoice?.customer?.customerName ?? '—',
    reason: n.reason,
    amount: num(n.totalAmount),
    // Strip Prisma-side `_cn` suffix → shared enum value (mirrors
    // mapCreditNote in utils/mappers.ts).
    status: String(n.status).endsWith('_cn') ? String(n.status).slice(0, -3) : String(n.status),
  }));

  const totals = {
    date: 'TOTAL', creditNoteNumber: '', invoiceNumber: '', customer: '', reason: '',
    amount: rows.reduce((s, r) => s + r.amount, 0),
    status: '',
  };

  return {
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'creditNoteNumber', label: 'CN Number' },
      { key: 'invoiceNumber', label: 'Invoice #' },
      { key: 'customer', label: 'Customer' },
      { key: 'reason', label: 'Reason' },
      { key: 'amount', label: 'Amount', money: true },
      { key: 'status', label: 'Status' },
    ],
    rows,
    totals,
  };
}

// ─── Report — Debit Notes Register (N29 · Chunk 3b · 2026-08-05) ────────
//
// Mirror of Credit Notes Register for DebitNote. Same joining-through-
// invoice tenant scope, same status-suffix normalisation (`_dn`).
export async function debitNotesRegister(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);

  const notes = await prisma.debitNote.findMany({
    where: {
      invoice: { distributorId },
      OR: [
        { issueDate: { gte: from, lte: to } },
        { AND: [{ issueDate: null }, { createdAt: { gte: from, lte: to } }] },
      ],
    },
    include: {
      invoice: {
        select: { invoiceNumber: true, customer: { select: { customerName: true } } },
      },
    },
    orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
  });

  const rows = notes.map((n) => ({
    date: n.issueDate ? dayKey(n.issueDate) : dayKey(n.createdAt),
    debitNoteNumber: n.debitNoteNumber ?? '',
    invoiceNumber: n.invoice?.invoiceNumber ?? '',
    customer: n.invoice?.customer?.customerName ?? '—',
    reason: n.reason,
    amount: num(n.totalAmount),
    status: String(n.status).endsWith('_dn') ? String(n.status).slice(0, -3) : String(n.status),
  }));

  const totals = {
    date: 'TOTAL', debitNoteNumber: '', invoiceNumber: '', customer: '', reason: '',
    amount: rows.reduce((s, r) => s + r.amount, 0),
    status: '',
  };

  return {
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'debitNoteNumber', label: 'DN Number' },
      { key: 'invoiceNumber', label: 'Invoice #' },
      { key: 'customer', label: 'Customer' },
      { key: 'reason', label: 'Reason' },
      { key: 'amount', label: 'Amount', money: true },
      { key: 'status', label: 'Status' },
    ],
    rows,
    totals,
  };
}

// ─── Report — Payment Method Mix (N17 · Chunk 4 · 2026-08-05) ───────────
//
// Monthly split of payments received by method (cash / UPI / cheque /
// online / bank_transfer / credit). Rows are per YYYY-MM month; each
// method has its own ₹ and % columns. Treasury planning + fraud
// pattern detection ("why did cash spike this month?").
export async function paymentMethodMix(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);

  const rows = await prisma.paymentTransaction.findMany({
    where: { distributorId, transactionDate: { gte: from, lte: to } },
    select: { transactionDate: true, amount: true, paymentMethod: true },
  });

  const methods: Array<'cash' | 'upi' | 'cheque' | 'online' | 'bank_transfer' | 'credit'> = [
    'cash', 'upi', 'cheque', 'online', 'bank_transfer', 'credit',
  ];

  type MonthRow = {
    month: string; total: number;
  } & Record<string, number | string>;
  const per = new Map<string, MonthRow>();
  for (const p of rows) {
    const month = dayKey(p.transactionDate).slice(0, 7); // YYYY-MM
    let row = per.get(month);
    if (!row) {
      row = { month, total: 0 };
      for (const m of methods) { row[m] = 0; row[`${m}Pct`] = 0; }
      per.set(month, row);
    }
    const amt = num(p.amount);
    row.total = (row.total as number) + amt;
    row[p.paymentMethod] = (row[p.paymentMethod] as number) + amt;
  }
  // Compute % per method per month.
  for (const row of per.values()) {
    for (const m of methods) {
      const amt = row[m] as number;
      row[`${m}Pct`] = row.total > 0 ? Math.round((amt / (row.total as number)) * 100) : 0;
    }
  }

  const sortedRows = [...per.values()].sort((a, b) => a.month.localeCompare(b.month));

  const totalsRow: MonthRow = { month: 'TOTAL', total: sortedRows.reduce((s, r) => s + (r.total as number), 0) };
  for (const m of methods) {
    totalsRow[m] = sortedRows.reduce((s, r) => s + (r[m] as number), 0);
    totalsRow[`${m}Pct`] = totalsRow.total > 0
      ? Math.round(((totalsRow[m] as number) / (totalsRow.total as number)) * 100)
      : 0;
  }

  const columns: ReportColumn[] = [
    { key: 'month', label: 'Month' },
    { key: 'total', label: 'Total Received', money: true },
    { key: 'cash', label: 'Cash', money: true },
    { key: 'cashPct', label: 'Cash %' },
    { key: 'upi', label: 'UPI', money: true },
    { key: 'upiPct', label: 'UPI %' },
    { key: 'cheque', label: 'Cheque', money: true },
    { key: 'chequePct', label: 'Cheque %' },
    { key: 'online', label: 'Online', money: true },
    { key: 'onlinePct', label: 'Online %' },
    { key: 'bank_transfer', label: 'Bank Transfer', money: true },
    { key: 'bank_transferPct', label: 'Bank %' },
    { key: 'credit', label: 'Credit', money: true },
    { key: 'creditPct', label: 'Credit %' },
  ];

  return {
    columns,
    rows: sortedRows,
    totals: totalsRow,
    chart: {
      type: 'bar',
      title: 'Monthly payment method mix',
      data: {
        labels: sortedRows.map((r) => r.month),
        series: methods.map((m) => ({
          name: m.charAt(0).toUpperCase() + m.slice(1).replace('_', ' '),
          values: sortedRows.map((r) => +((r[m] as number) ?? 0).toFixed(2)),
        })),
      },
    },
  };
}

// ─── Report — Rate Variance / Discount Leakage (N19 · Chunk 4) ──────────
//
// For each (customer, cylinderType) that has a configured discount in
// CustomerCylinderDiscount, compare the CONFIGURED discount vs the
// AVERAGE ACTUAL discount applied on OrderItem rows in the range.
// Variance > 0 = unauthorized extra discount given (margin leak).
// Variance < 0 = configured discount not fully applied (rare; usually
// a rate-master update that hasn't cascaded).
//
// Note: OrderItem.discountPerUnit is at the order level (raw storage);
// this report averages it across delivered orders in range.
export async function rateVarianceLeakage(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);

  // Configured discounts per (customer, cyl) — tenant-scoped via customer join.
  const configured = await prisma.customerCylinderDiscount.findMany({
    where: {
      customer: { distributorId, deletedAt: null },
      ...(f.customerId ? { customerId: f.customerId } : {}),
      ...(f.cylinderTypeId ? { cylinderTypeId: f.cylinderTypeId } : {}),
    },
    include: {
      customer: { select: { customerName: true } },
      cylinderType: { select: { typeName: true } },
    },
  });
  if (configured.length === 0) {
    return {
      columns: [
        { key: 'customer', label: 'Customer' },
        { key: 'cylinderType', label: 'Cylinder Type' },
        { key: 'configuredDiscount', label: 'Configured (₹/unit)', money: true },
        { key: 'avgActualDiscount', label: 'Avg Actual (₹/unit)', money: true },
        { key: 'variance', label: 'Variance (₹/unit)', money: true },
        { key: 'orderCount', label: 'Orders' },
        { key: 'totalImpact', label: 'Total ₹ Impact', money: true },
      ],
      rows: [], totals: {},
    };
  }

  // Actuals: per (customer, cyl) — sum discount * qty across delivered orders.
  const customerIds = [...new Set(configured.map((c) => c.customerId))];
  const cylTypeIds = [...new Set(configured.map((c) => c.cylinderTypeId))];
  const orderItems = await prisma.orderItem.findMany({
    where: {
      order: {
        distributorId,
        customerId: { in: customerIds },
        status: 'delivered',
        deliveryDate: { gte: from, lte: to },
        deletedAt: null,
      },
      cylinderTypeId: { in: cylTypeIds },
    },
    select: {
      order: { select: { customerId: true } },
      cylinderTypeId: true,
      quantity: true,
      deliveredQuantity: true,
      discountPerUnit: true,
    },
  });

  const key = (cid: string, tid: string) => `${cid}|${tid}`;
  const actualMap = new Map<string, { totalDiscount: number; totalQty: number; orderCount: number }>();
  for (const it of orderItems) {
    const cid = it.order.customerId;
    const k = key(cid, it.cylinderTypeId);
    const qty = it.deliveredQuantity ?? it.quantity;
    const disc = num(it.discountPerUnit);
    const cur = actualMap.get(k) ?? { totalDiscount: 0, totalQty: 0, orderCount: 0 };
    cur.totalDiscount += disc * qty;
    cur.totalQty += qty;
    cur.orderCount += 1;
    actualMap.set(k, cur);
  }

  const rows = configured.map((c) => {
    const k = key(c.customerId, c.cylinderTypeId);
    const actual = actualMap.get(k);
    const configuredDisc = num(c.discountPerUnit);
    const avgActual = actual && actual.totalQty > 0 ? actual.totalDiscount / actual.totalQty : 0;
    const variance = avgActual - configuredDisc;
    const totalImpact = actual ? Math.round(variance * actual.totalQty) : 0;
    return {
      customer: c.customer?.customerName ?? '—',
      customerId: c.customerId,
      cylinderType: c.cylinderType?.typeName ?? '—',
      configuredDiscount: Math.round(configuredDisc * 100) / 100,
      avgActualDiscount: Math.round(avgActual * 100) / 100,
      variance: Math.round(variance * 100) / 100,
      orderCount: actual?.orderCount ?? 0,
      totalImpact,
    };
  })
    // Show only rows with activity in range (variance is meaningful only
    // if we saw real orders — otherwise it's just the configured value).
    .filter((r) => r.orderCount > 0)
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));

  const totals = {
    customer: 'TOTAL', customerId: '', cylinderType: '',
    configuredDiscount: 0, avgActualDiscount: 0, variance: 0,
    orderCount: rows.reduce((s, r) => s + r.orderCount, 0),
    totalImpact: rows.reduce((s, r) => s + r.totalImpact, 0),
  };

  return {
    columns: [
      { key: 'customer', label: 'Customer' },
      { key: 'cylinderType', label: 'Cylinder Type' },
      { key: 'configuredDiscount', label: 'Configured (₹/unit)', money: true },
      { key: 'avgActualDiscount', label: 'Avg Actual (₹/unit)', money: true },
      { key: 'variance', label: 'Variance (₹/unit)', money: true },
      { key: 'orderCount', label: 'Orders' },
      { key: 'totalImpact', label: 'Total ₹ Impact', money: true },
    ],
    rows,
    totals,
  };
}

// ─── Report — Cash Book (N21 · Chunk 4 · 2026-08-05) ────────────────────
//
// Traditional day-wise cash flow (cash-only). Rows are per day in range,
// showing cash in (PaymentTransaction where method='cash') minus cash
// out (Expense where paymentMethod='cash'). Opening cash is NOT
// tracked yet (that's a v1.1 feature; for now the report shows daily
// net cash movement without carry-forward).
export async function cashBook(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const fromStr = dayKey(from);
  const toStr = dayKey(to);

  const [cashIn, cashOut] = await Promise.all([
    prisma.paymentTransaction.groupBy({
      by: ['transactionDate'],
      where: { distributorId, transactionDate: { gte: from, lte: to }, paymentMethod: 'cash' },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.expense.groupBy({
      by: ['expenseDate'],
      where: { distributorId, expenseDate: { gte: fromStr, lte: toStr }, paymentMethod: 'cash', deletedAt: null },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  type DayRow = { date: string; cashReceipts: number; receiptCount: number; cashExpenses: number; expenseCount: number; netCash: number };
  const per = new Map<string, DayRow>();
  const get = (dk: string): DayRow => {
    const existing = per.get(dk);
    if (existing) return existing;
    const fresh: DayRow = { date: dk, cashReceipts: 0, receiptCount: 0, cashExpenses: 0, expenseCount: 0, netCash: 0 };
    per.set(dk, fresh);
    return fresh;
  };
  for (const r of cashIn) {
    const dk = dayKey(r.transactionDate);
    const row = get(dk);
    row.cashReceipts += num(r._sum.amount);
    row.receiptCount += r._count;
  }
  for (const r of cashOut) {
    const row = get(r.expenseDate);
    row.cashExpenses += num(r._sum.amount);
    row.expenseCount += r._count;
  }

  const rows = [...per.values()].map((r) => {
    r.netCash = r.cashReceipts - r.cashExpenses;
    return r;
  }).sort((a, b) => a.date.localeCompare(b.date));

  const totals = {
    date: 'TOTAL',
    cashReceipts: rows.reduce((s, r) => s + r.cashReceipts, 0),
    receiptCount: rows.reduce((s, r) => s + r.receiptCount, 0),
    cashExpenses: rows.reduce((s, r) => s + r.cashExpenses, 0),
    expenseCount: rows.reduce((s, r) => s + r.expenseCount, 0),
    netCash: rows.reduce((s, r) => s + r.netCash, 0),
  };

  return {
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'cashReceipts', label: 'Cash Receipts', money: true },
      { key: 'receiptCount', label: 'Receipt Count' },
      { key: 'cashExpenses', label: 'Cash Expenses', money: true },
      { key: 'expenseCount', label: 'Expense Count' },
      { key: 'netCash', label: 'Net Cash', money: true },
    ],
    rows,
    totals,
  };
}

// ─── Report — Cashflow Statement (N22 · Chunk 4 · 2026-08-05) ───────────
//
// Monthly cashflow view. Rows are per YYYY-MM month. All-methods
// (not just cash — this is total cash movement across the business),
// broken into inflows (payments + deposits charged) and outflows
// (expenses + deposit refunds). Cumulative running column at the end.
export async function cashflowStatement(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const fromStr = dayKey(from);
  const toStr = dayKey(to);

  const [payments, deposits, expenses] = await Promise.all([
    prisma.paymentTransaction.findMany({
      where: { distributorId, transactionDate: { gte: from, lte: to } },
      select: { transactionDate: true, amount: true },
    }),
    prisma.customerLedgerEntry.findMany({
      where: {
        distributorId,
        entryType: { in: ['deposit_charged', 'deposit_refunded'] },
        entryDate: { gte: from, lte: to },
      },
      select: { entryType: true, entryDate: true, amountDelta: true },
    }),
    prisma.expense.findMany({
      where: { distributorId, expenseDate: { gte: fromStr, lte: toStr }, deletedAt: null },
      select: { expenseDate: true, amount: true },
    }),
  ]);

  type MonthRow = {
    month: string; inflowPayments: number; inflowDeposits: number; outflowExpenses: number; outflowRefunds: number;
    netCashflow: number; cumulative: number;
  };
  const per = new Map<string, MonthRow>();
  const get = (m: string): MonthRow => {
    const existing = per.get(m);
    if (existing) return existing;
    const fresh: MonthRow = { month: m, inflowPayments: 0, inflowDeposits: 0, outflowExpenses: 0, outflowRefunds: 0, netCashflow: 0, cumulative: 0 };
    per.set(m, fresh);
    return fresh;
  };
  for (const p of payments) get(dayKey(p.transactionDate).slice(0, 7)).inflowPayments += num(p.amount);
  for (const d of deposits) {
    const m = dayKey(d.entryDate).slice(0, 7);
    const row = get(m);
    if (d.entryType === 'deposit_charged') row.inflowDeposits += num(d.amountDelta);
    else if (d.entryType === 'deposit_refunded') row.outflowRefunds += Math.abs(num(d.amountDelta));
  }
  for (const e of expenses) get(e.expenseDate.slice(0, 7)).outflowExpenses += num(e.amount);

  const rows = [...per.values()].sort((a, b) => a.month.localeCompare(b.month));
  let cum = 0;
  for (const r of rows) {
    r.netCashflow = r.inflowPayments + r.inflowDeposits - r.outflowExpenses - r.outflowRefunds;
    cum += r.netCashflow;
    r.cumulative = cum;
  }

  const totals = {
    month: 'TOTAL',
    inflowPayments: rows.reduce((s, r) => s + r.inflowPayments, 0),
    inflowDeposits: rows.reduce((s, r) => s + r.inflowDeposits, 0),
    outflowExpenses: rows.reduce((s, r) => s + r.outflowExpenses, 0),
    outflowRefunds: rows.reduce((s, r) => s + r.outflowRefunds, 0),
    netCashflow: rows.reduce((s, r) => s + r.netCashflow, 0),
    cumulative: cum,
  };

  return {
    columns: [
      { key: 'month', label: 'Month' },
      { key: 'inflowPayments', label: 'Inflow: Payments', money: true },
      { key: 'inflowDeposits', label: 'Inflow: Deposits', money: true },
      { key: 'outflowExpenses', label: 'Outflow: Expenses', money: true },
      { key: 'outflowRefunds', label: 'Outflow: Refunds', money: true },
      { key: 'netCashflow', label: 'Net Cashflow', money: true },
      { key: 'cumulative', label: 'Cumulative', money: true },
    ],
    rows,
    totals,
    chart: {
      type: 'bar',
      title: 'Monthly cashflow — inflows vs outflows',
      data: {
        labels: rows.map((r) => r.month),
        series: [
          { name: 'Payments in', values: rows.map((r) => +r.inflowPayments.toFixed(2)) },
          { name: 'Deposits in', values: rows.map((r) => +r.inflowDeposits.toFixed(2)) },
          { name: 'Expenses out', values: rows.map((r) => +r.outflowExpenses.toFixed(2)) },
          { name: 'Refunds out', values: rows.map((r) => +r.outflowRefunds.toFixed(2)) },
        ],
      },
    },
  };
}

// ─── Report — Expenses-by-Category Trend (N33 · Chunk 4 · 2026-08-05) ───
//
// Category × month matrix. Complements the existing per-period
// byCategory summary on the Expenses tab (which is a snapshot). This
// one shows the MoM trend — catches cost drift ("fuel doubled since
// April") that a single-period view misses.
export async function expensesByCategoryTrend(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const fromStr = dayKey(from);
  const toStr = dayKey(to);

  const expenses = await prisma.expense.findMany({
    where: { distributorId, expenseDate: { gte: fromStr, lte: toStr }, deletedAt: null },
    include: { category: { select: { name: true } } },
  });

  // Rows keyed by categoryId; columns include each month in range + total.
  const months = new Set<string>();
  type Row = { category: string; categoryId: string; total: number } & Record<string, number | string>;
  const per = new Map<string, Row>();
  for (const e of expenses) {
    const m = e.expenseDate.slice(0, 7); // YYYY-MM
    months.add(m);
    const catName = e.category?.name ?? '—';
    let row = per.get(catName);
    if (!row) {
      row = { category: catName, categoryId: catName, total: 0 };
      per.set(catName, row);
    }
    const amt = num(e.amount);
    row[m] = ((row[m] as number) ?? 0) + amt;
    row.total = (row.total as number) + amt;
  }

  const monthList = [...months].sort();
  // Ensure every row has an entry for every month (0 if missing).
  for (const row of per.values()) {
    for (const m of monthList) if (row[m] === undefined) row[m] = 0;
  }

  const rows = [...per.values()].sort((a, b) => (b.total as number) - (a.total as number));

  const totalsRow: Row = { category: 'TOTAL', categoryId: '', total: rows.reduce((s, r) => s + (r.total as number), 0) };
  for (const m of monthList) {
    totalsRow[m] = rows.reduce((s, r) => s + ((r[m] as number) ?? 0), 0);
  }

  const columns: ReportColumn[] = [
    { key: 'category', label: 'Category' },
    ...monthList.map((m) => ({ key: m, label: m, money: true })),
    { key: 'total', label: 'Total', money: true },
  ];

  return {
    columns,
    rows,
    totals: totalsRow,
    // Chart: total spend per month (sum across all categories) as a line.
    chart: {
      type: 'line',
      title: 'Monthly expense total trend',
      data: monthList.map((m) => ({
        x: m,
        y: +(rows.reduce((s, r) => s + ((r[m] as number) ?? 0), 0)).toFixed(2),
      })),
    },
  };
}

// ─── Report — Opening Balance Certificates Register (N31 · Chunk 3b) ───
//
// Invoices where `isOpeningBalance = true` — the "certificate" invoices
// generated at distributor go-live to seed pre-existing customer debts.
// These render through the standard generateInvoicePdf's opening-balance
// branch. This register lists them so operators can audit / re-download
// any of them from one place.
export async function openingBalanceCertificatesRegister(distributorId: string, _f: ReportFilters): Promise<ReportResult> {
  // 2026-08-06: OB certs are a small historical set (issued once at go-live).
  // Applying the default month-ago..today date filter to them hides all rows
  // on a fresh install (go-live was months ago). Report always returns ALL
  // opening-balance invoices for the tenant; the date filter is intentionally
  // ignored. Operators asking "show me only OBs from March" can filter the
  // downloaded CSV.
  const invoices = await prisma.invoice.findMany({
    where: {
      distributorId,
      isOpeningBalance: true,
      deletedAt: null,
    },
    include: {
      customer: { select: { customerName: true } },
    },
    orderBy: [{ issueDate: 'desc' }, { invoiceNumber: 'asc' }],
  });

  const rows = invoices.map((inv) => ({
    issueDate: dayKey(inv.issueDate),
    invoiceNumber: inv.invoiceNumber,
    customer: inv.customer?.customerName ?? '—',
    totalAmount: num(inv.totalAmount),
    amountPaid: num(inv.amountPaid),
    outstanding: num(inv.outstandingAmount),
    status: String(inv.status),
  }));

  const totals = {
    issueDate: 'TOTAL', invoiceNumber: '', customer: '',
    totalAmount: rows.reduce((s, r) => s + r.totalAmount, 0),
    amountPaid: rows.reduce((s, r) => s + r.amountPaid, 0),
    outstanding: rows.reduce((s, r) => s + r.outstanding, 0),
    status: '',
  };

  return {
    columns: [
      { key: 'issueDate', label: 'Issue Date' },
      { key: 'invoiceNumber', label: 'Invoice #' },
      { key: 'customer', label: 'Customer' },
      { key: 'totalAmount', label: 'Total', money: true },
      { key: 'amountPaid', label: 'Paid', money: true },
      { key: 'outstanding', label: 'Outstanding', money: true },
      { key: 'status', label: 'Status' },
    ],
    rows,
    totals,
  };
}

// ─── Report — Accountability Log Report (N34 · Chunk 4 · 2026-08-05) ────
//
// Wraps the existing AccountabilityLog model in a listable report so
// operators + finance can pull cylinder / cash / other incidents as a
// downloadable audit trail. AccountabilityStatus enum uses the
// `_accountability` suffix (Prisma-side); we strip it for display
// consistency (mirrors CN / DN status normalisation pattern).
export async function accountabilityLogReport(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);

  const logs = await prisma.accountabilityLog.findMany({
    where: {
      distributorId,
      incidentDate: { gte: from, lte: to },
      ...(f.driverId ? { driverId: f.driverId } : {}),
      ...(f.customerId ? { customerId: f.customerId } : {}),
      ...(f.cylinderTypeId ? { cylinderTypeId: f.cylinderTypeId } : {}),
    },
    include: {
      driver: { select: { driverName: true } },
      customer: { select: { customerName: true } },
      cylinderType: { select: { typeName: true } },
    },
    orderBy: [{ incidentDate: 'desc' }, { createdAt: 'desc' }],
  });

  const rows = logs.map((l) => ({
    incidentDate: dayKey(l.incidentDate),
    incidentType: String(l.incidentType),
    driver: l.driver?.driverName ?? '—',
    customer: l.customer?.customerName ?? '—',
    cylinderType: l.cylinderType?.typeName ?? '—',
    quantity: l.quantity,
    costAmount: num(l.costAmount),
    description: l.description,
    status: String(l.status).endsWith('_accountability')
      ? String(l.status).slice(0, -'_accountability'.length)
      : String(l.status),
    resolutionNotes: l.resolutionNotes ?? '',
  }));

  const totals = {
    incidentDate: 'TOTAL', incidentType: '', driver: '', customer: '', cylinderType: '',
    quantity: rows.reduce((s, r) => s + r.quantity, 0),
    costAmount: rows.reduce((s, r) => s + r.costAmount, 0),
    description: '', status: '', resolutionNotes: '',
  };

  return {
    columns: [
      { key: 'incidentDate', label: 'Date' },
      { key: 'incidentType', label: 'Type' },
      { key: 'driver', label: 'Driver' },
      { key: 'customer', label: 'Customer' },
      { key: 'cylinderType', label: 'Cylinder Type' },
      { key: 'quantity', label: 'Qty' },
      { key: 'costAmount', label: 'Cost', money: true },
      { key: 'description', label: 'Description' },
      { key: 'status', label: 'Status' },
      { key: 'resolutionNotes', label: 'Resolution Notes' },
    ],
    rows,
    totals,
  };
}

// ─── Report — N15 GST Reconciliation (2026-08-06) ──────────────────────
//
// Three-way sanity check: for every delivered order in the range, compare
//   Dispatched qty (from OrderItem.deliveredQuantity ?? quantity)
//   Delivered   qty (from OrderItem.deliveredQuantity — post-dispute value)
//   IRN status  (invoice.irnStatus === 'success' with a non-null IRN)
//   EWB status  (invoice.ewbStatus === 'success' with a non-null EWB number)
//
// The important design decision — **skipped-by-design is NOT a mismatch**:
//   - B2B godown pickup     → IRN expected, EWB skipped (no vehicle)
//   - B2B no-vehicle non-godown → IRN expected, EWB skipped
//   - B2C URP + vehicle     → IRN skipped (URP customer), EWB expected
//   - B2C URP + godown      → both skipped (no legal doc required)
//   - Mini-op tenant        → both skipped (mini-op is out of GST scope)
//
// Report flags an order as MISMATCH only when the expected-shape says a
// doc SHOULD exist AND it's missing (or failed / cancelled).
//
// Row shape: one per order — Order # / Customer / Type / Vehicle / Qty
// dispatched / Qty delivered / IRN status / EWB status / Expected shape /
// Mismatch flag (true/false with reason).
//
// Filter: dateFrom + dateTo. Optional filter `mismatchOnly=true` narrows to
// problem rows only (piggybacks on `groupBy: 'trip'|'day'|'customer'|'invoice'`
// enum via a new `statusFilter` overload — reused from Delivery Performance
// statusFilter shape for consistency).
export async function gstReconciliation(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);

  // Distributor-level GST mode gate — mini-op tenants get an empty result
  // set with a friendly note row; every order is skipped-by-design.
  const distributor = await prisma.distributor.findUniqueOrThrow({
    where: { id: distributorId },
    select: { accountType: true, gstMode: true, gstin: true },
  });
  const isMiniOp = distributor.accountType === 'mini_operator';
  const gstDisabled = distributor.gstMode === 'disabled';

  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      deliveryDate: { gte: from, lte: to },
      status: { in: ['delivered', 'modified_delivered'] },
      deletedAt: null,
    },
    include: {
      items: { select: { deliveredQuantity: true, quantity: true } },
      customer: { select: { customerName: true, customerType: true, gstin: true } },
      vehicle: { select: { vehicleNumber: true } },
      invoice: {
        select: {
          id: true, invoiceNumber: true,
          irn: true, irnStatus: true,
          // Invoice.ewbStatus is enough — the actual ewbNo lives on
          // GstDocument. `success` status is our contract that a real
          // EWB number was recorded (see anti-pattern #24 phantom-success
          // guards — status='success' with null ewbNo would be caught by
          // that gate and flipped to 'failed').
          ewbStatus: true,
        },
      },
    },
    orderBy: [{ deliveryDate: 'asc' }, { orderNumber: 'asc' }],
  });

  // Classify each order into one of the 6 expected shapes + compute mismatch.
  type Row = {
    orderNumber: string;
    invoiceNumber: string;
    customer: string;
    customerType: string; // 'B2B' | 'B2C-URP' | 'B2C-GSTIN' | 'mini-op'
    vehicle: string;
    isGodown: string; // 'Yes' | 'No'
    qtyDispatched: number;
    qtyDelivered: number;
    irnExpected: string; // 'Yes' | 'No (skipped)'
    irnStatus: string;   // 'success' | 'failed' | 'not_attempted' | '—'
    ewbExpected: string;
    ewbStatus: string;
    mismatch: string; // 'OK' | 'IRN missing' | 'EWB missing' | 'Both missing'
    _isMismatch: boolean; // internal — for filter + row-highlight
  };

  const rows: Row[] = orders.map((o) => {
    const custType = o.customer?.customerType ?? 'B2C';
    const custHasGstin = !!o.customer?.gstin?.trim();
    // Effective classification:
    //  - mini-op tenant: everything is skipped
    //  - B2B or B2C-with-GSTIN: treat as B2B for GST purposes
    //  - B2C without GSTIN: URP
    const effectiveType: 'B2B' | 'B2C-URP' | 'mini-op' = isMiniOp || gstDisabled
      ? 'mini-op'
      : (custType === 'B2B' || custHasGstin)
        ? 'B2B'
        : 'B2C-URP';
    const isGodown = o.isGodownPickup;
    const hasVehicle = !!o.vehicleId;

    // Compute expected doc shape.
    let irnExpected: boolean;
    let ewbExpected: boolean;
    if (effectiveType === 'mini-op') { irnExpected = false; ewbExpected = false; }
    else if (effectiveType === 'B2B') { irnExpected = true; ewbExpected = hasVehicle && !isGodown; }
    else { // B2C-URP
      irnExpected = false;
      ewbExpected = hasVehicle && !isGodown;
    }

    const irnOk = o.invoice?.irnStatus === 'success' && !!o.invoice?.irn;
    // EwbStatus enum uses `active` (not `success`) for the successful state.
    const ewbOk = o.invoice?.ewbStatus === 'active';

    const irnMissing = irnExpected && !irnOk;
    const ewbMissing = ewbExpected && !ewbOk;
    const _isMismatch = irnMissing || ewbMissing;
    const mismatch = _isMismatch
      ? (irnMissing && ewbMissing ? 'IRN + EWB missing' : irnMissing ? 'IRN missing' : 'EWB missing')
      : 'OK';

    const qtyDispatched = o.items.reduce((s, it) => s + (it.deliveredQuantity ?? it.quantity), 0);
    const qtyDelivered = o.items.reduce((s, it) => s + (it.deliveredQuantity ?? it.quantity), 0);

    return {
      orderNumber: o.orderNumber,
      invoiceNumber: o.invoice?.invoiceNumber ?? '—',
      customer: o.customer?.customerName ?? '—',
      customerType: effectiveType === 'mini-op' ? 'Mini-op' : (custHasGstin && custType === 'B2C' ? 'B2C-GSTIN' : effectiveType),
      vehicle: o.vehicle?.vehicleNumber ?? (isGodown ? 'Godown pickup' : '—'),
      isGodown: isGodown ? 'Yes' : 'No',
      qtyDispatched,
      qtyDelivered,
      irnExpected: irnExpected ? 'Yes' : 'No (skipped)',
      irnStatus: irnExpected
        ? (irnOk ? 'success' : String(o.invoice?.irnStatus ?? 'not_attempted'))
        : '—',
      ewbExpected: ewbExpected ? 'Yes' : 'No (skipped)',
      ewbStatus: ewbExpected
        ? (ewbOk ? 'success' : String(o.invoice?.ewbStatus ?? 'not_attempted'))
        : '—',
      mismatch,
      _isMismatch,
    };
  });

  // Summary counts for the strip at the top.
  const delivered = rows.length;
  const irnExpectedCount = rows.filter((r) => r.irnExpected === 'Yes').length;
  const irnOkCount = rows.filter((r) => r.irnExpected === 'Yes' && r.irnStatus === 'success').length;
  const ewbExpectedCount = rows.filter((r) => r.ewbExpected === 'Yes').length;
  const ewbOkCount = rows.filter((r) => r.ewbExpected === 'Yes' && r.ewbStatus === 'success').length;
  const skippedByDesignCount = rows.filter((r) => r.irnExpected === 'No (skipped)' && r.ewbExpected === 'No (skipped)').length;
  const mismatchCount = rows.filter((r) => r._isMismatch).length;

  // Optional filter: statusFilter='mismatch' hides OK rows (client also has
  // a hide-columns option per Bundle F). Keep the internal flag stripped
  // from the final rows shape.
  const wantMismatchOnly = f.statusFilter === 'overdue'; // reuse existing enum slot as boolean-ish
  const filteredRows = wantMismatchOnly ? rows.filter((r) => r._isMismatch) : rows;
  const finalRows = filteredRows.map(({ _isMismatch: _drop, ...rest }) => { void _drop; return rest; });

  const totals = {
    orderNumber: 'TOTAL',
    invoiceNumber: '',
    customer: '',
    customerType: '',
    vehicle: '',
    isGodown: '',
    qtyDispatched: finalRows.reduce((s, r) => s + r.qtyDispatched, 0),
    qtyDelivered: finalRows.reduce((s, r) => s + r.qtyDelivered, 0),
    irnExpected: `${irnOkCount}/${irnExpectedCount}`,
    irnStatus: `${skippedByDesignCount} skipped-by-design`,
    ewbExpected: `${ewbOkCount}/${ewbExpectedCount}`,
    ewbStatus: `${mismatchCount} mismatch`,
    mismatch: `${delivered} orders`,
  };

  return {
    columns: [
      { key: 'orderNumber', label: 'Order #' },
      { key: 'invoiceNumber', label: 'Invoice #' },
      { key: 'customer', label: 'Customer' },
      { key: 'customerType', label: 'Type' },
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'isGodown', label: 'Godown' },
      { key: 'qtyDispatched', label: 'Qty Dispatched' },
      { key: 'qtyDelivered', label: 'Qty Delivered' },
      { key: 'irnExpected', label: 'IRN Expected?' },
      { key: 'irnStatus', label: 'IRN Status' },
      { key: 'ewbExpected', label: 'EWB Expected?' },
      { key: 'ewbStatus', label: 'EWB Status' },
      { key: 'mismatch', label: 'Reconciliation' },
    ],
    rows: finalRows,
    totals,
  };
}

// ─── Report — N16 GSTR-3B Preview (Outward Supplies — 2026-08-06) ──────
//
// Compresses the month's outward taxable supplies into the shape GSTR-3B
// Table 3.1 needs: per tax slab (0/5/12/18/28 %) show taxable value + IGST
// + CGST + SGST + Cess. Includes credit-note / debit-note adjustments
// (Table 3.1(a) NET of CN, plus Table 3.1(b) if there are any zero-rated).
//
// SCOPE: outward supplies only (Table 3.1). ITC + reverse-charge + inward
// supplies are NOT in scope — those need purchase data + reverse-charge
// classification which is a separate report track. Distributor still needs
// to fill those sections manually on the GST portal.
//
// Data source: Invoice + CreditNote + DebitNote for the month. Uses the
// per-line tax split written by createInvoiceFromOrder + processInvoiceGst.
//
// Filter behavior: dateFrom + dateTo. Typical use: pick a whole month.
export async function gstr3bPreview(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);

  const invoices = await prisma.invoice.findMany({
    where: {
      distributorId,
      deletedAt: null,
      status: { not: 'cancelled' },
      issueDate: { gte: from, lte: to },
    },
    include: {
      items: { select: { gstRate: true, totalPrice: true } },
    },
  });

  const creditNotes = await prisma.creditNote.findMany({
    where: {
      invoice: { distributorId },
      issueDate: { gte: from, lte: to },
      status: { in: ['approved_cn', 'issued'] },
    },
    select: { taxableValue: true, cgstValue: true, sgstValue: true, igstValue: true, totalAmount: true },
  });

  const debitNotes = await prisma.debitNote.findMany({
    where: {
      invoice: { distributorId },
      issueDate: { gte: from, lte: to },
      status: { in: ['approved_dn', 'issued_dn'] },
    },
    select: { totalAmount: true },
  });

  // Aggregate per slab. Taxable value derives from item.totalPrice divided
  // by (1 + tax/100) for GST-inclusive pricing (see anti-pattern #16 —
  // Invoice.totalAmount is inclusive; per-line item.totalPrice inclusive).
  interface SlabAgg { taxable: number; cgst: number; sgst: number; igst: number; }
  const bySlab = new Map<string, SlabAgg>();
  const getSlab = (rate: number): SlabAgg => {
    const key = String(rate);
    const existing = bySlab.get(key);
    if (existing) return existing;
    const fresh: SlabAgg = { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    bySlab.set(key, fresh);
    return fresh;
  };

  // Total tax-inclusive → tax-exclusive conversion per invoice per slab.
  // Every invoice line has a gstRate on InvoiceItem (Float, defaults to 18%
  // — set at write time by createInvoiceFromOrder from CylinderType or
  // CustomerGstRateOverride). For invoices without a per-line rate
  // (historical rows only), fall back to 18% which is the LPG default.
  for (const inv of invoices) {
    // Split per line by rate to feed the per-slab table.
    for (const it of inv.items) {
      const rate = num(it.gstRate) || 18;
      const inclusive = num(it.totalPrice);
      const taxable = inclusive / (1 + rate / 100);
      const taxAmount = inclusive - taxable;
      const slab = getSlab(rate);
      slab.taxable += taxable;
      // Intra-state split (cgst+sgst = half+half). Inter-state (igst)
      // approximated from the invoice-level split — if invoice has igst
      // > 0, treat this line's tax as igst too. Not perfectly accurate
      // for mixed intra/inter invoices (rare) but adequate for GSTR-3B
      // aggregate preview.
      if (num(inv.igstValue) > 0) {
        slab.igst += taxAmount;
      } else {
        slab.cgst += taxAmount / 2;
        slab.sgst += taxAmount / 2;
      }
    }
  }

  // CN adjustment: subtract taxable + taxes from the aggregate. We don't
  // split CN by slab (CreditNote table stores single taxable+cgst+sgst
  // values without slab breakdown) — GSTR-3B allows a lumped CN line
  // (Table 3.1 "Outward taxable supplies … other than zero rated" is net).
  const cnTaxable = creditNotes.reduce((s, c) => s + num(c.taxableValue), 0);
  const cnCGST = creditNotes.reduce((s, c) => s + num(c.cgstValue), 0);
  const cnSGST = creditNotes.reduce((s, c) => s + num(c.sgstValue), 0);
  const cnIGST = creditNotes.reduce((s, c) => s + num(c.igstValue), 0);

  const dnTotal = debitNotes.reduce((s, d) => s + num(d.totalAmount), 0);

  const rows: Array<{ metric: string; taxable: number | string; cgst: number | string; sgst: number | string; igst: number | string; total: number | string }> = [];

  // Table 3.1(a) — Outward taxable supplies (other than zero-rated),
  // gross per slab. Sorted by slab ascending.
  const sortedSlabs = [...bySlab.entries()].sort(([a], [b]) => Number(a) - Number(b));
  const hdr = (title: string) => rows.push({ metric: `── ${title} ──`, taxable: '', cgst: '', sgst: '', igst: '', total: '' });

  hdr('3.1(a) Outward taxable supplies (gross)');
  for (const [rate, agg] of sortedSlabs) {
    if (agg.taxable === 0) continue;
    rows.push({
      metric: `  ${rate}% slab`,
      taxable: Math.round(agg.taxable),
      cgst: Math.round(agg.cgst),
      sgst: Math.round(agg.sgst),
      igst: Math.round(agg.igst),
      total: Math.round(agg.taxable + agg.cgst + agg.sgst + agg.igst),
    });
  }
  const grossTaxable = sortedSlabs.reduce((s, [, a]) => s + a.taxable, 0);
  const grossCGST = sortedSlabs.reduce((s, [, a]) => s + a.cgst, 0);
  const grossSGST = sortedSlabs.reduce((s, [, a]) => s + a.sgst, 0);
  const grossIGST = sortedSlabs.reduce((s, [, a]) => s + a.igst, 0);
  rows.push({
    metric: 'Sub-total (gross)',
    taxable: Math.round(grossTaxable),
    cgst: Math.round(grossCGST),
    sgst: Math.round(grossSGST),
    igst: Math.round(grossIGST),
    total: Math.round(grossTaxable + grossCGST + grossSGST + grossIGST),
  });

  hdr('Adjustments — Credit Notes (reduce liability)');
  rows.push({
    metric: '  Credit Notes issued',
    taxable: -Math.round(cnTaxable),
    cgst: -Math.round(cnCGST),
    sgst: -Math.round(cnSGST),
    igst: -Math.round(cnIGST),
    total: -Math.round(cnTaxable + cnCGST + cnSGST + cnIGST),
  });

  hdr('Adjustments — Debit Notes (increase liability)');
  rows.push({
    metric: '  Debit Notes issued (total value)',
    taxable: '', cgst: '', sgst: '', igst: '',
    total: Math.round(dnTotal),
  });

  hdr('NET Outward taxable liability');
  const netTaxable = grossTaxable - cnTaxable;
  const netCGST = grossCGST - cnCGST;
  const netSGST = grossSGST - cnSGST;
  const netIGST = grossIGST - cnIGST;
  const netTotal = netTaxable + netCGST + netSGST + netIGST + dnTotal;
  rows.push({
    metric: 'Table 3.1(a) — net',
    taxable: Math.round(netTaxable),
    cgst: Math.round(netCGST),
    sgst: Math.round(netSGST),
    igst: Math.round(netIGST),
    total: Math.round(netTotal),
  });

  return {
    columns: [
      { key: 'metric', label: 'Section / Slab' },
      { key: 'taxable', label: 'Taxable Value', money: true },
      { key: 'cgst', label: 'CGST', money: true },
      { key: 'sgst', label: 'SGST', money: true },
      { key: 'igst', label: 'IGST', money: true },
      { key: 'total', label: 'Total', money: true },
    ],
    rows,
  };
}

// ─── Report — N18 Customer Profitability (2026-08-06) ─────────────────
//
// Answers "which customers actually make us money after we finance their
// credit + their held empty cylinders?" Per customer over the date range:
//
//   Revenue         = Σ delivered orders' totalAmount
//   Avg Outstanding = (opening balance at from−1 + closing balance at to) / 2
//                     — computed from CustomerLedgerEntry running sum
//   Days            = (dateTo − dateFrom) in days (inclusive)
//   AR Cost         = Avg Outstanding × (rate/100) × (Days / 365)
//   Empty Deposit   = Σ (customer's withCustomerQty × emptyCylinderPrice)
//   Empty Cost      = Empty Deposit × (rate/100) × (Days / 365)
//   Adjusted Rev    = Revenue − AR Cost − Empty Cost
//   Margin %        = Adjusted Revenue / Revenue × 100
//   DSO (days)      = Avg Outstanding / (Revenue / Days)  when Revenue > 0
//
// Interest rate comes from `filters.arInterestRatePct` (defaults to 12%).
// COGS is DELIBERATELY not included — see V3 §N18-backlog: needs
// purchase-based landed-cost model, deferred.
//
// Sort: adjusted revenue ASCENDING (worst customers on top — the ones
// eating the most credit-cost per rupee of revenue). Filter by customerId
// optional.
export async function customerProfitability(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const rate = Math.max(0, Math.min(50, f.arInterestRatePct ?? 12));
  const daysMs = to.getTime() - from.getTime();
  const days = Math.max(1, Math.round(daysMs / (24 * 60 * 60 * 1000)) + 1); // inclusive

  // Step 1 — revenue per customer + delivered-order count.
  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      status: { in: ['delivered', 'modified_delivered'] },
      deliveryDate: { gte: from, lte: to },
      deletedAt: null,
      ...(f.customerId ? { customerId: f.customerId } : {}),
    },
    select: {
      customerId: true,
      totalAmount: true,
      customer: { select: { customerName: true } },
    },
  });

  interface Agg {
    customerId: string;
    customer: string;
    orders: number;
    revenue: number;
    // Filled in by later steps.
    openingBalance: number;
    closingBalance: number;
    emptiesValue: number;
  }
  const per = new Map<string, Agg>();
  for (const o of orders) {
    const row = per.get(o.customerId) ?? {
      customerId: o.customerId,
      customer: o.customer?.customerName ?? '—',
      orders: 0,
      revenue: 0,
      openingBalance: 0,
      closingBalance: 0,
      emptiesValue: 0,
    };
    row.orders += 1;
    row.revenue += num(o.totalAmount);
    per.set(o.customerId, row);
  }
  const customerIds = [...per.keys()];
  if (customerIds.length === 0) {
    return {
      columns: n18Columns(),
      rows: [],
      totals: {},
    };
  }

  // Step 2 — opening balance (all ledger entries strictly BEFORE `from`)
  // and closing balance (all entries UP TO `to`). Ledger's amountDelta
  // convention: positive = customer owes MORE (invoice raised); negative
  // = customer owes LESS (payment received or credit note). Running sum
  // = current outstanding.
  const [openingSums, closingSums] = await Promise.all([
    prisma.customerLedgerEntry.groupBy({
      by: ['customerId'],
      where: { distributorId, customerId: { in: customerIds }, entryDate: { lt: from } },
      _sum: { amountDelta: true },
    }),
    prisma.customerLedgerEntry.groupBy({
      by: ['customerId'],
      where: { distributorId, customerId: { in: customerIds }, entryDate: { lte: to } },
      _sum: { amountDelta: true },
    }),
  ]);
  for (const o of openingSums) {
    const row = per.get(o.customerId);
    if (row) row.openingBalance = num(o._sum.amountDelta);
  }
  for (const c of closingSums) {
    const row = per.get(c.customerId);
    if (row) row.closingBalance = num(c._sum.amountDelta);
  }

  // Step 3 — empties value = held qty × empty price (per cyl type).
  // Uses the latest effective EmptyCylinderPrice per (distributor, cyl).
  const balances = await prisma.customerInventoryBalance.findMany({
    where: { customerId: { in: customerIds }, withCustomerQty: { gt: 0 } },
    select: { customerId: true, cylinderTypeId: true, withCustomerQty: true },
  });
  const emptyPrices = await prisma.emptyCylinderPrice.findMany({
    where: { distributorId },
    orderBy: [{ cylinderTypeId: 'asc' }, { effectiveDate: 'desc' }],
    distinct: ['cylinderTypeId'],
    select: { cylinderTypeId: true, emptyCylinderPrice: true },
  });
  const emptyPriceMap = new Map(emptyPrices.map((p) => [p.cylinderTypeId, num(p.emptyCylinderPrice)]));
  for (const b of balances) {
    const row = per.get(b.customerId);
    if (!row) continue;
    const priceEach = emptyPriceMap.get(b.cylinderTypeId) ?? 0;
    row.emptiesValue += b.withCustomerQty * priceEach;
  }

  // Step 4 — derive AR Cost, Empty Cost, Adjusted Revenue, DSO, Margin %.
  const rateFactor = (rate / 100) * (days / 365);
  const rows = [...per.values()]
    .map((r) => {
      const avgOutstanding = (r.openingBalance + r.closingBalance) / 2;
      const arCost = avgOutstanding * rateFactor;
      const emptyCost = r.emptiesValue * rateFactor;
      const adjustedRevenue = r.revenue - arCost - emptyCost;
      const marginPct = r.revenue > 0 ? Math.round((adjustedRevenue / r.revenue) * 10000) / 100 : 0;
      const dso = r.revenue > 0 ? Math.round(avgOutstanding / (r.revenue / days)) : 0;
      return {
        customer: r.customer,
        customerId: r.customerId,
        orders: r.orders,
        revenue: Math.round(r.revenue),
        avgOutstanding: Math.round(avgOutstanding),
        dso,
        emptiesValue: Math.round(r.emptiesValue),
        arCost: Math.round(arCost),
        emptyCost: Math.round(emptyCost),
        adjustedRevenue: Math.round(adjustedRevenue),
        marginPct,
      };
    })
    // Worst-margin customers on top: sort by adjustedRevenue ASC
    // (customers who are the biggest drag on margin surface first).
    .sort((a, b) => a.adjustedRevenue - b.adjustedRevenue);

  const totals = {
    customer: 'TOTAL',
    customerId: '',
    orders: rows.reduce((s, r) => s + r.orders, 0),
    revenue: rows.reduce((s, r) => s + r.revenue, 0),
    avgOutstanding: rows.reduce((s, r) => s + r.avgOutstanding, 0),
    dso: rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.dso, 0) / rows.length) : 0,
    emptiesValue: rows.reduce((s, r) => s + r.emptiesValue, 0),
    arCost: rows.reduce((s, r) => s + r.arCost, 0),
    emptyCost: rows.reduce((s, r) => s + r.emptyCost, 0),
    adjustedRevenue: rows.reduce((s, r) => s + r.adjustedRevenue, 0),
    marginPct: '',
  };

  return {
    columns: n18Columns(),
    rows,
    totals,
  };
}

function n18Columns(): ReportColumn[] {
  return [
    { key: 'customer', label: 'Customer' },
    { key: 'orders', label: 'Orders' },
    { key: 'revenue', label: 'Revenue', money: true },
    { key: 'avgOutstanding', label: 'Avg Outstanding', money: true },
    { key: 'dso', label: 'DSO (days)' },
    { key: 'emptiesValue', label: 'Empties Value', money: true },
    { key: 'arCost', label: 'AR Cost', money: true },
    { key: 'emptyCost', label: 'Empty Deposit Cost', money: true },
    { key: 'adjustedRevenue', label: 'Adjusted Revenue', money: true },
    { key: 'marginPct', label: 'Margin %' },
  ];
}

// ─── F8v2-R Corporation-bucket reports (2026-08-06) ──────────────────────
//
// 5 reports built on the Corporation Ledger data model (PurchaseEntry +
// PurchasePayment + PurchaseCreditNote + PurchaseDebitNote + landed cost).
// All accept optional `sourceDistributorId` filter to scope to one OMC.
// All accept dateFrom/dateTo for window narrowing.
//
// Deposit invoices (documentType='deposit_invoice') are EXCLUDED from
// these reports — deposits are a refundable pool tracked separately on
// the Corporation Ledger page and don't participate in gas outstanding
// / landed cost / sale margin math.

async function corpLandedCostTrend(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { computeLandedCost } = await import('./landedCostService.js');
  const result = await computeLandedCost(distributorId, {
    from: f.dateFrom,
    to: f.dateTo,
    sourceDistributorId: f.sourceDistributorId,
  });

  const columns: ReportColumn[] = [
    { key: 'month', label: 'Month' },
    { key: 'cylinderTypeName', label: 'Cyl Type' },
    { key: 'cylindersReceived', label: 'Received' },
    { key: 'lineTotal', label: 'Line ₹', money: true },
    { key: 'freightAllocated', label: 'Freight ₹', money: true },
    { key: 'cnOffset', label: 'CN Offset ₹', money: true },
    { key: 'dnOffset', label: 'DN Added ₹', money: true },
    { key: 'landedTotal', label: 'Landed Total ₹', money: true },
    { key: 'landedPerCyl', label: 'Landed / Cyl ₹', money: true },
  ];

  // Line chart: one series per cyl type, x = month, y = landed/cyl.
  // Group rows by cyl type, sort each series by month.
  const seriesMap = new Map<string, Array<{ x: string; y: number }>>();
  const allMonths = new Set<string>();
  for (const r of result.rows) {
    allMonths.add(r.month);
    if (!seriesMap.has(r.cylinderTypeName)) seriesMap.set(r.cylinderTypeName, []);
    seriesMap.get(r.cylinderTypeName)!.push({ x: r.month, y: r.landedPerCyl });
  }
  const sortedMonths = Array.from(allMonths).sort();
  const chart: ReportChart | undefined = seriesMap.size > 0
    ? {
        type: 'bar',
        title: `Landed cost / cyl trend (${result.gstMode === 'disabled' ? 'GST-incl' : 'GST-excl'})`,
        data: {
          labels: sortedMonths,
          series: Array.from(seriesMap.entries()).map(([cyl, pts]) => ({
            name: cyl,
            values: sortedMonths.map((m) => pts.find((p) => p.x === m)?.y ?? 0),
          })),
        },
      }
    : undefined;

  return {
    columns,
    rows: result.rows as unknown as Record<string, unknown>[],
    totals: {
      cylinderTypeName: 'Total',
      cylindersReceived: result.summary.totalCylsReceived,
      lineTotal: result.summary.totalLineValue,
      freightAllocated: result.summary.totalFreight,
      cnOffset: result.summary.totalCnOffset,
      dnOffset: result.summary.totalDnOffset,
      landedTotal: result.summary.grandLanded,
      landedPerCyl:
        result.summary.totalCylsReceived > 0
          ? round2(result.summary.grandLanded / result.summary.totalCylsReceived)
          : 0,
    },
    chart,
  };
}

async function corpStatementRegister(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const suppliers = await prisma.sourceDistributor.findMany({
    where: {
      distributorId,
      deletedAt: null,
      ...(f.sourceDistributorId ? { id: f.sourceDistributorId } : {}),
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const from = f.dateFrom ?? '1900-01-01';
  const to = f.dateTo ?? '2099-12-31';

  // For each supplier, pull invoice + payment + CN + DN totals bucketed by
  // yyyy-mm. Deposit invoices excluded per Corporation-report convention.
  interface RegisterRow {
    corporation: string;
    month: string;
    purchases: number;
    payments: number;
    creditNotes: number;
    debitNotes: number;
    netMovement: number;
    closingBalance: number;
  }
  const rows: RegisterRow[] = [];

  for (const s of suppliers) {
    // Load all events for this supplier ordered by date so we can carry a
    // running closing balance across months.
    const [entries, payments, cns, dns] = await Promise.all([
      prisma.purchaseEntry.findMany({
        where: {
          distributorId,
          sourceDistributorId: s.id,
          deletedAt: null,
          documentType: 'invoice',
        },
        select: {
          purchaseDate: true,
          items: { select: { unitPrice: true, fullsReceived: true } },
          charges: { select: { amount: true } },
        },
      }),
      prisma.purchasePayment.findMany({
        where: { distributorId, sourceDistributorId: s.id, deletedAt: null },
        select: { transactionDate: true, amount: true },
      }),
      prisma.purchaseCreditNote.findMany({
        where: { distributorId, sourceDistributorId: s.id, deletedAt: null },
        select: { creditNoteDate: true, totalAmount: true },
      }),
      prisma.purchaseDebitNote.findMany({
        where: { distributorId, sourceDistributorId: s.id, deletedAt: null },
        select: { debitNoteDate: true, totalAmount: true },
      }),
    ]);

    // Bucket by yyyy-mm.
    interface Bucket { purchases: number; payments: number; cns: number; dns: number }
    const buckets = new Map<string, Bucket>();
    const monthKey = (d: string) => d.slice(0, 7);
    const bump = (m: string, key: keyof Bucket, v: number) => {
      if (!buckets.has(m)) buckets.set(m, { purchases: 0, payments: 0, cns: 0, dns: 0 });
      buckets.get(m)![key] += v;
    };

    for (const e of entries) {
      const items = e.items.reduce(
        (sum, it) => sum + Number(it.unitPrice) * it.fullsReceived,
        0,
      );
      const charges = e.charges.reduce((sum, c) => sum + Number(c.amount), 0);
      bump(monthKey(e.purchaseDate), 'purchases', items + charges);
    }
    for (const p of payments) bump(monthKey(p.transactionDate), 'payments', Number(p.amount));
    for (const c of cns) bump(monthKey(c.creditNoteDate), 'cns', Number(c.totalAmount));
    for (const d of dns) bump(monthKey(d.debitNoteDate), 'dns', Number(d.totalAmount));

    const sortedMonths = Array.from(buckets.keys()).sort();
    let running = 0;
    for (const m of sortedMonths) {
      const b = buckets.get(m)!;
      const net = b.purchases + b.dns - b.payments - b.cns;
      running += net;
      const monthStart = `${m}-01`;
      const monthEnd = `${m}-31`;
      // Filter by requested window (only include months intersecting range).
      if (monthEnd < from || monthStart > to) continue;
      rows.push({
        corporation: s.name,
        month: m,
        purchases: round2(b.purchases),
        payments: round2(b.payments),
        creditNotes: round2(b.cns),
        debitNotes: round2(b.dns),
        netMovement: round2(net),
        closingBalance: round2(running),
      });
    }
  }

  // Sort corporation then month, so per-corp progression reads top-to-bottom.
  rows.sort((a, b) =>
    a.corporation === b.corporation
      ? a.month.localeCompare(b.month)
      : a.corporation.localeCompare(b.corporation),
  );

  const columns: ReportColumn[] = [
    { key: 'corporation', label: 'Corporation' },
    { key: 'month', label: 'Month' },
    { key: 'purchases', label: 'Purchases ₹', money: true },
    { key: 'payments', label: 'Payments ₹', money: true },
    { key: 'creditNotes', label: 'CN ₹', money: true },
    { key: 'debitNotes', label: 'DN ₹', money: true },
    { key: 'netMovement', label: 'Net Move ₹', money: true },
    { key: 'closingBalance', label: 'Closing Bal ₹', money: true },
  ];

  const totals = {
    month: 'TOTAL',
    purchases: round2(rows.reduce((s, r) => s + r.purchases, 0)),
    payments: round2(rows.reduce((s, r) => s + r.payments, 0)),
    creditNotes: round2(rows.reduce((s, r) => s + r.creditNotes, 0)),
    debitNotes: round2(rows.reduce((s, r) => s + r.debitNotes, 0)),
    netMovement: round2(rows.reduce((s, r) => s + r.netMovement, 0)),
    closingBalance: '—',
  };

  return { columns, rows: rows as unknown as Record<string, unknown>[], totals };
}

async function corpPurchaseVsSaleMargin(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { computeLandedCost } = await import('./landedCostService.js');
  const landed = await computeLandedCost(distributorId, {
    from: f.dateFrom,
    to: f.dateTo,
    sourceDistributorId: f.sourceDistributorId,
  });

  // For each (month, cyl type) in the landed-cost result, join to the
  // customer-side sale rate for the same cyl type + month window.
  // Sale rate = Σ InvoiceItem.totalPrice / Σ InvoiceItem.quantity, filtered
  // by invoice issueDate in the same month.
  interface Row {
    month: string;
    cylinderTypeName: string;
    cylindersReceived: number;
    landedPerCyl: number;
    soldPerCyl: number;
    marginPerCyl: number;
    marginPct: number;
    cylindersSold: number;
  }
  const rows: Row[] = [];

  for (const lr of landed.rows) {
    const monthStart = `${lr.month}-01`;
    const [y, m] = lr.month.split('-').map(Number);
    // Next month's first day → exclusive upper bound.
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const monthEndEx = `${nextY}-${String(nextM).padStart(2, '0')}-01`;

    const items = await prisma.invoiceItem.findMany({
      where: {
        cylinderTypeId: lr.cylinderTypeId,
        invoice: {
          distributorId,
          deletedAt: null,
          issueDate: { gte: new Date(monthStart), lt: new Date(monthEndEx) },
        },
      },
      select: { quantity: true, totalPrice: true },
    });

    const qtySold = items.reduce((s, it) => s + it.quantity, 0);
    const valSold = items.reduce((s, it) => s + Number(it.totalPrice), 0);
    const soldPerCyl = qtySold > 0 ? round2(valSold / qtySold) : 0;
    const marginPerCyl = round2(soldPerCyl - lr.landedPerCyl);
    const marginPct = soldPerCyl > 0 ? round2((marginPerCyl / soldPerCyl) * 100) : 0;

    rows.push({
      month: lr.month,
      cylinderTypeName: lr.cylinderTypeName,
      cylindersReceived: lr.cylindersReceived,
      landedPerCyl: lr.landedPerCyl,
      soldPerCyl,
      marginPerCyl,
      marginPct,
      cylindersSold: qtySold,
    });
  }

  const columns: ReportColumn[] = [
    { key: 'month', label: 'Month' },
    { key: 'cylinderTypeName', label: 'Cyl Type' },
    { key: 'cylindersReceived', label: 'Received' },
    { key: 'landedPerCyl', label: 'Landed / Cyl ₹', money: true },
    { key: 'cylindersSold', label: 'Sold' },
    { key: 'soldPerCyl', label: 'Sold / Cyl ₹', money: true },
    { key: 'marginPerCyl', label: 'Margin / Cyl ₹', money: true },
    { key: 'marginPct', label: 'Margin %' },
  ];

  return { columns, rows: rows as unknown as Record<string, unknown>[] };
}

async function corpSupplierPaymentAging(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  // Per corp: sum of open outstanding invoice balances bucketed by age
  // (0-30 / 31-60 / 61-90 / 90+ days) based on the invoice's supplierDocumentDate
  // (OMC issue date) OR purchaseDate as fallback.
  const asOf = f.dateTo ? new Date(f.dateTo) : new Date(); // "as-of" date defaults to today
  // NOTE — using `new Date()` on the server for report as-of date is
  // legitimate; anti-pattern #21 restricts only user-facing date defaults
  // and query-boundary date strings.

  const suppliers = await prisma.sourceDistributor.findMany({
    where: {
      distributorId,
      deletedAt: null,
      ...(f.sourceDistributorId ? { id: f.sourceDistributorId } : {}),
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  interface AgeRow {
    corporation: string;
    b0_30: number;
    b31_60: number;
    b61_90: number;
    b90plus: number;
    total: number;
  }
  const rows: AgeRow[] = [];

  for (const s of suppliers) {
    const entries = await prisma.purchaseEntry.findMany({
      where: {
        distributorId,
        sourceDistributorId: s.id,
        deletedAt: null,
        documentType: 'invoice',
      },
      select: {
        id: true,
        purchaseDate: true,
        supplierDocumentDate: true,
        amountPaid: true,
        items: { select: { unitPrice: true, fullsReceived: true } },
        charges: { select: { amount: true } },
        cnAllocations: {
          where: { purchaseCreditNote: { deletedAt: null } },
          select: { amount: true },
        },
      },
    });

    const bucket: AgeRow = {
      corporation: s.name,
      b0_30: 0,
      b31_60: 0,
      b61_90: 0,
      b90plus: 0,
      total: 0,
    };

    for (const e of entries) {
      const gross =
        e.items.reduce((sum, it) => sum + Number(it.unitPrice) * it.fullsReceived, 0) +
        e.charges.reduce((sum, c) => sum + Number(c.amount), 0);
      const paid = Number(e.amountPaid);
      const cn = e.cnAllocations.reduce((sum, a) => sum + Number(a.amount), 0);
      const outstanding = gross - paid - cn;
      if (outstanding <= 0.005) continue;

      const issueDate = new Date(e.supplierDocumentDate ?? e.purchaseDate);
      const ageDays = Math.floor(
        (asOf.getTime() - issueDate.getTime()) / (24 * 60 * 60 * 1000),
      );
      if (ageDays <= 30) bucket.b0_30 += outstanding;
      else if (ageDays <= 60) bucket.b31_60 += outstanding;
      else if (ageDays <= 90) bucket.b61_90 += outstanding;
      else bucket.b90plus += outstanding;
      bucket.total += outstanding;
    }

    bucket.b0_30 = round2(bucket.b0_30);
    bucket.b31_60 = round2(bucket.b31_60);
    bucket.b61_90 = round2(bucket.b61_90);
    bucket.b90plus = round2(bucket.b90plus);
    bucket.total = round2(bucket.total);

    if (bucket.total > 0.005) rows.push(bucket);
  }

  const columns: ReportColumn[] = [
    { key: 'corporation', label: 'Corporation' },
    { key: 'b0_30', label: '0-30 days ₹', money: true },
    { key: 'b31_60', label: '31-60 days ₹', money: true },
    { key: 'b61_90', label: '61-90 days ₹', money: true },
    { key: 'b90plus', label: '90+ days ₹', money: true },
    { key: 'total', label: 'Total Outstanding ₹', money: true },
  ];

  const totals = {
    corporation: 'TOTAL',
    b0_30: round2(rows.reduce((s, r) => s + r.b0_30, 0)),
    b31_60: round2(rows.reduce((s, r) => s + r.b31_60, 0)),
    b61_90: round2(rows.reduce((s, r) => s + r.b61_90, 0)),
    b90plus: round2(rows.reduce((s, r) => s + r.b90plus, 0)),
    total: round2(rows.reduce((s, r) => s + r.total, 0)),
  };

  return { columns, rows: rows as unknown as Record<string, unknown>[], totals };
}

async function corpLandedCostReconciliation(
  distributorId: string,
  f: ReportFilters,
): Promise<ReportResult> {
  // Side-by-side: per (month, cyl type), what did the OMC's HEADLINE invoice
  // rate say (raw unitPrice avg), vs what did we actually end up paying per
  // cyl after freight + CN + DN net-out. Variance highlights when landed
  // cost drifts significantly from the invoice rate (freight burn, incentive
  // gaps, extra billing).
  const { computeLandedCost } = await import('./landedCostService.js');
  const landed = await computeLandedCost(distributorId, {
    from: f.dateFrom,
    to: f.dateTo,
    sourceDistributorId: f.sourceDistributorId,
  });

  // For each landed row, compute the raw invoice rate = Σ(unitPrice ×
  // fullsReceived) ÷ Σ(fullsReceived) from PurchaseEntryItem in the same
  // window. This is what the OMC's headline rate averages to.
  interface Row {
    month: string;
    cylinderTypeName: string;
    cylindersReceived: number;
    invoiceRate: number;    // OMC headline rate per cyl
    landedPerCyl: number;   // what we actually paid per cyl after adjustments
    variancePerCyl: number; // landed - invoiceRate
    variancePct: number;
  }
  const rows: Row[] = [];

  for (const lr of landed.rows) {
    const monthStart = `${lr.month}-01`;
    const [y, m] = lr.month.split('-').map(Number);
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const monthEndEx = `${nextY}-${String(nextM).padStart(2, '0')}-01`;

    const items = await prisma.purchaseEntryItem.findMany({
      where: {
        cylinderTypeId: lr.cylinderTypeId,
        purchaseEntry: {
          distributorId,
          deletedAt: null,
          documentType: 'invoice',
          ...(f.sourceDistributorId ? { sourceDistributorId: f.sourceDistributorId } : {}),
          purchaseDate: { gte: monthStart, lt: monthEndEx },
        },
      },
      select: { unitPrice: true, fullsReceived: true },
    });
    const qty = items.reduce((s, it) => s + it.fullsReceived, 0);
    const val = items.reduce((s, it) => s + Number(it.unitPrice) * it.fullsReceived, 0);
    const invoiceRate = qty > 0 ? round2(val / qty) : 0;
    const variance = round2(lr.landedPerCyl - invoiceRate);
    const variancePct = invoiceRate > 0 ? round2((variance / invoiceRate) * 100) : 0;

    rows.push({
      month: lr.month,
      cylinderTypeName: lr.cylinderTypeName,
      cylindersReceived: lr.cylindersReceived,
      invoiceRate,
      landedPerCyl: lr.landedPerCyl,
      variancePerCyl: variance,
      variancePct,
    });
  }

  const columns: ReportColumn[] = [
    { key: 'month', label: 'Month' },
    { key: 'cylinderTypeName', label: 'Cyl Type' },
    { key: 'cylindersReceived', label: 'Received' },
    { key: 'invoiceRate', label: 'OMC Rate / Cyl ₹', money: true },
    { key: 'landedPerCyl', label: 'Landed / Cyl ₹', money: true },
    { key: 'variancePerCyl', label: 'Variance / Cyl ₹', money: true },
    { key: 'variancePct', label: 'Variance %' },
  ];

  return { columns, rows: rows as unknown as Record<string, unknown>[] };
}

// Local helper used by corpStatementRegister + others above. reportsService
// already has round2 in various inner scopes but not at module level; add one.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const REPORTS: Record<string, (d: string, f: ReportFilters) => Promise<ReportResult>> = {
  'sales-summary': salesSummary,
  'outstanding-aging': outstandingAging,
  'gst-summary': gstSummary,
  'delivery-performance': deliveryPerformance,
  'inventory-movement': inventoryMovement,
  'customer-statement': customerStatement,
  'vehicle-ledger': vehicleLedger,
  'payment-collections': paymentCollections,
  'day-close-summary': dayCloseSummary,
  'daily-sales': dailySales,
  // 2026-08-06: DailyDriverMovement + RouteDriverPerformance merged into
  // driverDailyLog (below). Old slugs deleted from catalog + client.
  'driver-daily-log': driverDailyLog,
  'deposit-ledger-by-customer': depositLedgerByCustomer,
  'stock-adjustment-audit-log': stockAdjustmentAuditLog,
  'expense-register': expenseRegister,
  'credit-notes-register': creditNotesRegister,
  'debit-notes-register': debitNotesRegister,
  'opening-balance-certificates-register': openingBalanceCertificatesRegister,
  'cylinder-rotation': cylinderRotation,
  'driver-vehicle-cost-breakdown': driverVehicleCostBreakdown,
  'empties-in-transit': emptiesInTransit,
  'payment-method-mix': paymentMethodMix,
  'rate-variance-leakage': rateVarianceLeakage,
  'cash-book': cashBook,
  'cashflow-statement': cashflowStatement,
  'expenses-by-category-trend': expensesByCategoryTrend,
  'accountability-log-report': accountabilityLogReport,
  // 2026-08-06 — N15 + N16 (statutory reports)
  'gst-reconciliation': gstReconciliation,
  'gstr-3b-preview': gstr3bPreview,
  // 2026-08-06 — N18 Customer Profitability (Financial bucket)
  'customer-profitability': customerProfitability,
  // F8v2-R (2026-08-06) — Corporation bucket reports
  'corp-landed-cost-trend': corpLandedCostTrend,
  'corp-statement-register': corpStatementRegister,
  'corp-purchase-vs-sale-margin': corpPurchaseVsSaleMargin,
  'corp-supplier-payment-aging': corpSupplierPaymentAging,
  'corp-landed-cost-reconciliation': corpLandedCostReconciliation,
};

// ─── Report Catalog (F2 2026-08-05) ─────────────────────────────────────
//
// The BUCKETS array defines the 7 top-level groups shown as headers in
// the Reports left-nav. Sort order is `order` ascending. Every new bucket
// added later must also be added to the `ReportBucket` union in
// packages/shared/src/types/index.ts (compile-time linkage).
//
// The CATALOG array is the flat list of every report the UI can navigate
// to. New reports (N01-N34) get appended here as they land in later chunks
// — no schema, no route surgery. The Reports frontend consumes this via
// GET /api/reports/catalog (added in Step 2 of this chunk).

import type { ReportBucketDef, ReportCatalogEntry } from '@gaslink/shared';
import { UserRole } from '@gaslink/shared';

export const REPORT_BUCKETS: ReportBucketDef[] = [
  { key: 'daily-book',         label: 'Daily Book',         order: 1, description: 'What happened today — sales, deliveries, driver + vehicle activity' },
  { key: 'invoicing-payments', label: 'Invoicing & Payments', order: 2, description: 'Invoices, credit notes, payments, aging' },
  { key: 'inventory',          label: 'Inventory',          order: 3, description: 'Depot stock, adjustments, defective cylinders' },
  { key: 'customers',          label: 'Customers',          order: 4, description: 'Per-customer statements, activity, deposits, profitability' },
  { key: 'corporation',        label: 'Corporation',        order: 5, description: 'OMC purchases, landed cost, supplier aging, sale-margin — everything downstream of Corporation Ledger' },
  { key: 'expenses',           label: 'Expenses',           order: 6, description: 'Operational costs, categories, trends' },
  { key: 'month-end',          label: 'Month-End',          order: 7, description: 'GST filings, Tally, cash book, P&L, cashflow' },
];

// Shorthand: every role that can currently open the flat /api/reports/*
// endpoints (baseline gate on routes/reports.ts).
const ROLES_ALL_STAFF: UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.DISTRIBUTOR_ADMIN,
  UserRole.FINANCE,
  UserRole.INVENTORY,
  UserRole.MINI_OPERATOR_ADMIN,
];

// Narrower: excludes inventory + mini_op — for GST filing operations.
const ROLES_FINANCE_ONLY: UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.DISTRIBUTOR_ADMIN,
  UserRole.FINANCE,
];

export const REPORT_CATALOG: ReportCatalogEntry[] = [
  // ── Daily Book ────────────────────────────────────────────────────────
  {
    slug: 'sales-summary',
    label: 'Sales Summary',
    bucket: 'daily-book',
    description: 'Revenue by customer with daily-trend chart',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'delivery-performance',
    label: 'Delivery Performance',
    bucket: 'daily-book',
    description: 'Per-driver deliveries, revenue, empties collected',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'vehicle-ledger',
    label: 'Vehicle Ledger',
    bucket: 'daily-book',
    description: 'Per-trip physical movement — dispatched, delivered, returned, empties, outstanding',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'day-close-summary',
    label: 'Day-Close Summary',
    bucket: 'daily-book',
    description: 'End-of-day one-pager — revenue, payments by method, deliveries, closing stock, expenses, customers',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'daily-sales',
    label: 'Daily Sales',
    bucket: 'daily-book',
    description: 'Day-by-day operational log — deliveries, revenue, payments received per day',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  // 2026-08-06 — merge of DailyDriverMovement + RouteDriverPerformance.
  // Per (date × driver) rows with trip-level chevron drill-down; absorbs
  // both the per-day movement lens and the efficiency-scorecard lens
  // (on-time % + cancel %) that used to live in the two separate reports.
  {
    slug: 'driver-daily-log',
    label: 'Driver Daily Log',
    bucket: 'daily-book',
    description: 'Per-day per-driver log — trips, deliveries, fulls + empties, revenue, on-time %, cancel %. Click a driver row to expand per-trip detail.',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  // Driver Statement (PDF) removed from the catalog 2026-08-06 — the entry
  // rendered a dead-end EmptyState ("Pick a driver first — open Delivery
  // Performance …") because it needs a driver selection the sidebar can't
  // supply. The PDF stays available exactly where operators actually use
  // it: Delivery Performance → drill into a driver → "Statement" button
  // (see DeliveryPerformanceDrillDownModal in ReportsPage.tsx). If we ever
  // want a standalone sidebar entry, it must ship with an inline driver
  // picker in its panel, not a navigation instruction.

  // ── Invoicing & Payments ──────────────────────────────────────────────
  {
    slug: 'credit-notes-register',
    label: 'Credit Notes Register',
    bucket: 'invoicing-payments',
    description: 'Every credit note issued in range — number, invoice, customer, reason, amount, status',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'debit-notes-register',
    label: 'Debit Notes Register',
    bucket: 'invoicing-payments',
    description: 'Every debit note issued in range — number, invoice, customer, reason, amount, status',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'opening-balance-certificates-register',
    label: 'Opening Balance Certificates',
    bucket: 'invoicing-payments',
    description: 'Every opening-balance invoice — go-live seed debts by customer with paid + outstanding',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'payment-method-mix',
    label: 'Payment Method Mix',
    bucket: 'invoicing-payments',
    description: 'Monthly split of payments by method — cash, UPI, cheque, online, bank, credit',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'rate-variance-leakage',
    label: 'Rate Variance / Discount Leakage',
    bucket: 'invoicing-payments',
    description: 'Customers whose actual discount drifts from configured discount — margin leaks',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'delivery-challan-pdf',
    label: 'Delivery Challan (PDF)',
    bucket: 'invoicing-payments',
    description: 'Non-taxable delivery challan for delivery-before-invoice flows',
    kind: 'external',
    href: '/app/orders',
    outputs: ['pdf'],
    roles: ROLES_ALL_STAFF,
    comingSoon: true,
  },
  {
    slug: 'outstanding-aging',
    label: 'Outstanding & Aging',
    bucket: 'invoicing-payments',
    description: 'Per-customer AR bucketed 0-30 / 31-60 / 60+',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'payment-collections',
    label: 'Payment Collections',
    bucket: 'invoicing-payments',
    description: 'One row per invoice touched in range; Sale = Paid Earlier + Paid Today + Pending',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },

  // ── Inventory ────────────────────────────────────────────────────────
  {
    slug: 'inventory-movement',
    label: 'Inventory Movement',
    bucket: 'inventory',
    description: 'Per-day per-cyl opening / dispatched / delivered / cancelled / closing',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },

  // ── Customers ────────────────────────────────────────────────────────
  {
    slug: 'customer-statement',
    label: 'Customer Statement',
    bucket: 'customers',
    description: 'Running customer ledger with opening balance carry-forward',
    kind: 'inline',
    outputs: ['json', 'csv', 'pdf'],
    roles: ROLES_ALL_STAFF,
    requires: 'customer',
  },

  {
    slug: 'deposit-ledger-by-customer',
    label: 'Deposit Ledger per Customer',
    bucket: 'customers',
    description: 'Per-customer deposit balance — opening, charged, refunded, closing',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  // 2026-08-06 (FX-G v2): Cylinder Rotation moved to Inventory bucket only.
  // The earlier "mirror" (two catalog entries pointing at one report) was
  // scrapped per Suneel — same report in two places was confusing. It's
  // fundamentally an inventory / deposit-float question, so Inventory wins.
  {
    slug: 'accountability-log-report',
    label: 'Accountability Log',
    bucket: 'customers',
    description: 'Cylinder / cash / other incidents — audit trail of accountability entries',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'stock-adjustment-audit-log',
    label: 'Stock Adjustment Audit Log',
    bucket: 'inventory',
    description: 'Every manual stock adjustment — who, when, why, delta',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'empties-in-transit',
    label: 'Empties in Transit',
    bucket: 'inventory',
    description: 'Empties neither at depot nor returned — dispatched-not-back + held by customers',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'cylinder-rotation',
    label: 'Cylinder Rotation',
    bucket: 'inventory',
    description: 'Who is holding your cylinders longest — deposit float + avg-days-per-delivery deviation',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },

  // ── Suppliers / OMCs ─────────────────────────────────────────────────
  // (Populated in Sprint D when F8 lands. Empty for now.)

  // ── Expenses ─────────────────────────────────────────────────────────
  {
    slug: 'expense-register',
    label: 'Expense Register',
    bucket: 'expenses',
    description: 'Flat list of every expense in range — category, method, vendor, vehicle, driver',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'driver-vehicle-cost-breakdown',
    label: 'Driver & Vehicle Cost Breakdown',
    bucket: 'expenses',
    description: 'Per driver + vehicle — fuel, maintenance, toll, insurance broken out; ₹/delivery + cost % of revenue',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'expenses-by-category-trend',
    label: 'Expenses by Category (Trend)',
    bucket: 'expenses',
    description: 'Month-over-month spend per expense category — spots cost drift',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },

  // ── Month-End ────────────────────────────────────────────────────────
  {
    slug: 'gst-summary',
    label: 'GST Summary',
    bucket: 'month-end',
    description: 'Per-invoice taxable / CGST / SGST / IGST breakdown',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'gst-filing-export',
    label: 'GST Filing Export (monthly)',
    bucket: 'month-end',
    description: 'Multi-sheet xlsx for GSTR-1 preparation',
    kind: 'download',
    href: '/api/reports/gst-filing-export',
    outputs: ['xlsx'],
    roles: ROLES_FINANCE_ONLY,
  },
  {
    slug: 'tally-export',
    label: 'Tally Export',
    bucket: 'month-end',
    description: 'Tally-compatible XML for a date range',
    kind: 'download',
    href: '/api/reports/tally-export',
    outputs: ['xml'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'cash-book',
    label: 'Cash Book',
    bucket: 'month-end',
    description: 'Day-wise cash-only flow — receipts, payments, net cash movement',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'cashflow-statement',
    label: 'Cashflow Statement',
    bucket: 'month-end',
    description: 'Monthly cashflow — payments + deposits in, expenses + refunds out, cumulative running',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  // 2026-08-06 — N15 GST Reconciliation. Statutory / compliance bucket.
  // Flags real doc-missing cases; ignores skipped-by-design (godown, B2C URP,
  // mini-op) so operators don't cry wolf. Finance-heavy — role gate to
  // finance-only staff.
  {
    slug: 'gst-reconciliation',
    label: 'GST Reconciliation',
    bucket: 'month-end',
    description: 'Three-way match: dispatched vs delivered vs IRN\'d/EWB\'d — flags real mismatches, ignores godown / B2C URP / mini-op orders (skipped by design)',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_FINANCE_ONLY,
  },
  // 2026-08-06 — N16 GSTR-3B Preview (Table 3.1 outward supplies only).
  // Aggregates the month's taxable value + CGST/SGST/IGST per slab, with
  // CN/DN adjustments. ITC + reverse-charge sections deferred.
  {
    slug: 'gstr-3b-preview',
    label: 'GSTR-3B Preview',
    bucket: 'month-end',
    description: 'Table 3.1 outward supplies compressed by tax slab, with CN/DN adjustments — copy-paste into GST portal',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_FINANCE_ONLY,
  },
  // 2026-08-06 — N18 Customer Profitability. Answers "which customers
  // eat the most credit + empty-deposit float per rupee of revenue?"
  // Interest rate is a per-run input on top (editable — differs from
  // time to time). Lives in Customers bucket per V3 §3.1 (customer-
  // centric AR/activity). COGS is deferred to backlog (needs purchase-
  // based landed-cost model, see V3 §N18-backlog).
  {
    slug: 'customer-profitability',
    label: 'Customer Profitability',
    bucket: 'customers',
    description: 'Revenue − AR interest cost − empty-deposit float cost. Interest rate editable per-run. Worst-margin customers on top.',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  // ── Corporation (F8v2-R 2026-08-06) ─────────────────────────────────
  {
    slug: 'corp-landed-cost-trend',
    label: 'Landed Cost Trend',
    bucket: 'corporation',
    description: 'Per cyl-type, per month: landed cost / cyl over time. Shows if OMC pricing is drifting up.',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'corp-statement-register',
    label: 'Corporation Statement Register',
    bucket: 'corporation',
    description: 'One row per (corp, month): purchases, payments, CN, DN, net move, running closing balance. Consolidated across all OMCs.',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'corp-purchase-vs-sale-margin',
    label: 'Purchase vs Sale Margin',
    bucket: 'corporation',
    description: 'Landed cost / cyl vs sale rate / cyl for the same cyl type + month → margin ₹ + margin %. Are you pricing customer sales enough over what you paid the OMC?',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'corp-supplier-payment-aging',
    label: 'Supplier Payment Aging',
    bucket: 'corporation',
    description: 'Outstanding payables per OMC bucketed by age (0-30 / 31-60 / 61-90 / 90+ days). Am I falling behind on any OMC payment?',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
  {
    slug: 'corp-landed-cost-reconciliation',
    label: 'Landed Cost Reconciliation',
    bucket: 'corporation',
    description: 'OMC headline rate / cyl vs true landed / cyl (after freight + CN + DN). Variance highlights where invoice rate misleads.',
    kind: 'inline',
    outputs: ['json', 'csv'],
    roles: ROLES_ALL_STAFF,
  },
];

/**
 * Return the catalog filtered to only the entries the given role is
 * allowed to see. `entries` order matches CATALOG declaration order
 * so buckets fill up naturally.
 */
export function getReportCatalog(role: UserRole): { buckets: ReportBucketDef[]; entries: ReportCatalogEntry[] } {
  const entries = REPORT_CATALOG.filter((e) => e.roles.includes(role));
  return { buckets: REPORT_BUCKETS, entries };
}

/** Convert a ReportResult to CSV text (header + rows + totals row). */
export function reportToCsv(result: ReportResult): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = result.columns.map((c) => esc(c.label)).join(',');
  const lines = result.rows.map((r) => result.columns.map((c) => esc(r[c.key])).join(','));
  if (result.totals) lines.push(result.columns.map((c) => esc(result.totals![c.key])).join(','));
  return [header, ...lines].join('\n');
}
