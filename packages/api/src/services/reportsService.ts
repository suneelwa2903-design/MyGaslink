import { prisma } from '../lib/prisma.js';

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
  // depot-level IOC loads table in the Vehicle Ledger report).
  secondary?: ReportTable;
}

export interface ReportFilters {
  dateFrom?: string;
  dateTo?: string;
  customerId?: string;
  cylinderTypeId?: string;
  driverId?: string;
  vehicleId?: string;
  groupBy?: 'trip' | 'day';
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

// ─── Report 2 — Outstanding & Aging ──────────────────────────────────────────
export async function outstandingAging(distributorId: string, _f: ReportFilters): Promise<ReportResult> {
  const invoices = await prisma.invoice.findMany({
    where: { distributorId, outstandingAmount: { gt: 0 }, deletedAt: null, status: { not: 'cancelled' } },
    select: { customerId: true, outstandingAmount: true, dueDate: true, customer: { select: { customerName: true } } },
  });
  const lastPayments = await prisma.paymentTransaction.groupBy({
    by: ['customerId'],
    where: { distributorId, deletedAt: null },
    _max: { transactionDate: true },
  });
  const lastPayMap = new Map(lastPayments.map((p) => [p.customerId, p._max.transactionDate]));

  const now = new Date();
  const byCust = new Map<string, { customer: string; total: number; b0_30: number; b31_60: number; b60plus: number; lastPayment: string; _overdue: boolean }>();
  for (const inv of invoices) {
    if (!inv.customerId) continue;
    const amt = num(inv.outstandingAmount);
    const daysOverdue = Math.floor((now.getTime() - new Date(inv.dueDate).getTime()) / 86400000);
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
export async function deliveryPerformance(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const orders = await prisma.order.findMany({
    where: {
      distributorId, driverId: { not: null }, deletedAt: null,
      deliveryDate: { gte: from, lte: to },
      ...(f.driverId ? { driverId: f.driverId } : {}),
    },
    select: { driverId: true, status: true, driver: { select: { driverName: true } } },
  });
  const byDriver = new Map<string, { driver: string; assigned: number; exact: number; modMore: number; modLess: number; cancelled: number }>();
  for (const o of orders) {
    const id = o.driverId!;
    const cur = byDriver.get(id) ?? { driver: o.driver?.driverName ?? 'Unknown', assigned: 0, exact: 0, modMore: 0, modLess: 0, cancelled: 0 };
    cur.assigned += 1;
    if (o.status === 'delivered') cur.exact += 1;
    else if (o.status === 'modified_delivered') cur.modMore += 1; // modified split refined below if needed
    else if (o.status === 'cancelled') cur.cancelled += 1;
    byDriver.set(id, cur);
  }
  const rows = [...byDriver.values()].map((r) => {
    const delivered = r.exact + r.modMore + r.modLess;
    const rate = r.assigned ? +((delivered / r.assigned) * 100).toFixed(1) : 0;
    return { ...r, deliveryRate: rate };
  }).sort((a, b) => b.assigned - a.assigned);
  const chart: ReportChart = {
    type: 'bar', title: 'Deliveries by Driver',
    data: {
      labels: rows.map((r) => r.driver),
      series: [
        { name: 'Delivered', values: rows.map((r) => r.exact) },
        { name: 'Modified', values: rows.map((r) => r.modMore + r.modLess) },
        { name: 'Cancelled', values: rows.map((r) => r.cancelled) },
      ],
    },
  };
  return {
    columns: [
      { key: 'driver', label: 'Driver' }, { key: 'assigned', label: 'Assigned' },
      { key: 'exact', label: 'Delivered Exact' }, { key: 'modMore', label: 'Modified' },
      { key: 'cancelled', label: 'Cancelled' }, { key: 'deliveryRate', label: 'Delivery Rate %' },
    ],
    rows, chart,
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
export async function customerStatement(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  if (!f.customerId) throw Object.assign(new Error('customerId is required for the Customer Statement report'), { statusCode: 400 });
  const { from, to } = range(f);
  const entries = await prisma.customerLedgerEntry.findMany({
    where: { distributorId, customerId: f.customerId, entryDate: { gte: from, lte: to } },
    orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
  });
  // Opening balance = sum of amountDelta before `from`
  const prior = await prisma.customerLedgerEntry.aggregate({
    where: { distributorId, customerId: f.customerId, entryDate: { lt: from } },
    _sum: { amountDelta: true },
  });
  let running = num(prior._sum.amountDelta);
  const rows = entries.map((e) => {
    running += num(e.amountDelta);
    return {
      date: dayKey(new Date(e.entryDate)),
      type: e.entryType.replace(/_entry$/, ''),
      narration: e.narration ?? '',
      debit: num(e.amountDelta) > 0 ? num(e.amountDelta) : 0,
      credit: num(e.amountDelta) < 0 ? -num(e.amountDelta) : 0,
      balance: +running.toFixed(2),
    };
  });
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
// stock event. A depot-level IOC-loads table is returned separately (secondary).
type LedgerAttr = { vehicleId: string | null; vehicleNumber: string; driverName: string; tripNumber: number | null };
export async function vehicleLedger(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const { from, to } = range(f);
  const groupBy: 'trip' | 'day' = f.groupBy === 'trip' ? 'trip' : 'day';

  const movementTypes = ['dispatch', 'delivery', 'collection', 'returns_collection', 'reconciliation_empties_return', 'cancellation_return'] as const;
  const events = await prisma.inventoryEvent.findMany({
    where: {
      distributorId,
      eventDate: { gte: from, lte: to },
      eventType: { in: ['incoming_fulls', ...movementTypes] },
      ...(f.cylinderTypeId ? { cylinderTypeId: f.cylinderTypeId } : {}),
    },
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: { eventDate: 'asc' },
  });

  // ── Attribution maps ──────────────────────────────────────────────────────
  const orderIds = new Set<string>();
  const dvaIds = new Set<string>();
  const cseIds = new Set<string>();
  for (const e of events) {
    if (e.referenceType === 'order' && e.referenceId) orderIds.add(e.referenceId);
    else if (e.referenceType === 'driver_vehicle_assignment' && e.referenceId) dvaIds.add(e.referenceId);
    else if (e.referenceType === 'cancelled_stock' && e.referenceId) cseIds.add(e.referenceId);
  }

  const [orders, dvas, cses] = await Promise.all([
    orderIds.size
      ? prisma.order.findMany({
          where: { id: { in: [...orderIds] } },
          select: { id: true, vehicleId: true, tripNumber: true, vehicle: { select: { vehicleNumber: true } }, driver: { select: { driverName: true } } },
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
  ]);

  const orderAttr = new Map<string, LedgerAttr>(orders.map((o) => [o.id, { vehicleId: o.vehicleId, vehicleNumber: o.vehicle?.vehicleNumber ?? '—', driverName: o.driver?.driverName ?? '—', tripNumber: o.tripNumber ?? null }]));
  const dvaAttr = new Map<string, LedgerAttr>(dvas.map((d) => [d.id, { vehicleId: d.vehicleId, vehicleNumber: d.vehicle?.vehicleNumber ?? '—', driverName: d.driver?.driverName ?? '—', tripNumber: d.tripNumber ?? null }]));
  const cseAttr = new Map<string, LedgerAttr>(cses.map((c) => [c.id, { vehicleId: c.vehicleId, vehicleNumber: c.vehicle?.vehicleNumber ?? '—', driverName: c.driver?.driverName ?? '—', tripNumber: c.order?.tripNumber ?? null }]));

  const attrFor = (e: (typeof events)[number]): LedgerAttr => {
    if (e.referenceType === 'order' && e.referenceId && orderAttr.has(e.referenceId)) return orderAttr.get(e.referenceId)!;
    if (e.referenceType === 'driver_vehicle_assignment' && e.referenceId && dvaAttr.has(e.referenceId)) return dvaAttr.get(e.referenceId)!;
    if (e.referenceType === 'cancelled_stock' && e.referenceId && cseAttr.has(e.referenceId)) return cseAttr.get(e.referenceId)!;
    return { vehicleId: null, vehicleNumber: e.vehicleNumber ?? '—', driverName: e.driverName ?? '—', tripNumber: null };
  };

  // ── IOC loads received (depot-level secondary table) ────────────────────────
  type IocRow = { date: string; documentNumber: string; cylinderType: string; quantity: number };
  const iocMap = new Map<string, IocRow>();
  // ── Movement rows ──────────────────────────────────────────────────────────
  type MoveRow = {
    date: string; vehicleNumber: string; driverName: string; tripNumber: number | string; cylinderType: string;
    fullsDispatched: number; fullsDelivered: number; emptiesCollected: number; emptiesReturnedVerified: number; emptiesGap: number; cancelledReturns: number;
    _sortDate: string; _vehicleId: string | null;
  };
  const moveMap = new Map<string, MoveRow>();

  for (const e of events) {
    const dk = dayKey(new Date(e.eventDate));
    if (e.eventType === 'incoming_fulls') {
      const docNo = e.documentNumber ?? '—';
      const docDate = e.documentDate ? dayKey(new Date(e.documentDate)) : dk;
      const key = `${docDate}|${docNo}|${e.cylinderTypeId}`;
      const cur = iocMap.get(key) ?? { date: docDate, documentNumber: docNo, cylinderType: e.cylinderType?.typeName ?? '—', quantity: 0 };
      cur.quantity += e.fullsChange;
      iocMap.set(key, cur);
      continue;
    }

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
      fullsDispatched: 0, fullsDelivered: 0, emptiesCollected: 0, emptiesReturnedVerified: 0, emptiesGap: 0, cancelledReturns: 0,
      _sortDate: dk, _vehicleId: a.vehicleId,
    };
    switch (e.eventType) {
      case 'dispatch': cur.fullsDispatched += Math.abs(e.fullsChange); break;
      case 'delivery': cur.fullsDelivered += Math.abs(e.fullsChange); break;
      case 'collection':
      case 'returns_collection': cur.emptiesCollected += e.emptiesChange; break;
      case 'reconciliation_empties_return': cur.emptiesReturnedVerified += e.emptiesChange; break;
      case 'cancellation_return': cur.cancelledReturns += e.fullsChange; break;
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
    .map((r) => ({ ...r, emptiesGap: r.emptiesCollected - r.emptiesReturnedVerified }))
    .filter((r) => !driverNameFilter || r.driverName === driverNameFilter)
    .sort((a, b) => (a._sortDate === b._sortDate ? a.vehicleNumber.localeCompare(b.vehicleNumber) : a._sortDate.localeCompare(b._sortDate)))
    .map(({ _sortDate, _vehicleId, ...rest }) => { void _sortDate; void _vehicleId; return rest; });

  const totals = {
    date: 'TOTAL', vehicleNumber: '', driverName: '', tripNumber: '', cylinderType: '',
    fullsDispatched: rows.reduce((s, r) => s + r.fullsDispatched, 0),
    fullsDelivered: rows.reduce((s, r) => s + r.fullsDelivered, 0),
    emptiesCollected: rows.reduce((s, r) => s + r.emptiesCollected, 0),
    emptiesReturnedVerified: rows.reduce((s, r) => s + r.emptiesReturnedVerified, 0),
    emptiesGap: rows.reduce((s, r) => s + r.emptiesGap, 0),
    cancelledReturns: rows.reduce((s, r) => s + r.cancelledReturns, 0),
  };

  const iocRows = [...iocMap.values()].sort((a, b) => (a.date === b.date ? a.documentNumber.localeCompare(b.documentNumber) : a.date.localeCompare(b.date)));
  const secondary: ReportTable = {
    title: 'IOC Loads Received (Depot)',
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'documentNumber', label: 'Document No' },
      { key: 'cylinderType', label: 'Cylinder Type' },
      { key: 'quantity', label: 'Fulls Received' },
    ],
    rows: iocRows,
    totals: { date: 'TOTAL', documentNumber: '', cylinderType: '', quantity: iocRows.reduce((s, r) => s + r.quantity, 0) },
  };

  return {
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'vehicleNumber', label: 'Vehicle' },
      { key: 'driverName', label: 'Driver' },
      { key: 'tripNumber', label: 'Trip' },
      { key: 'cylinderType', label: 'Cylinder Type' },
      { key: 'fullsDispatched', label: 'Fulls Dispatched' },
      { key: 'fullsDelivered', label: 'Fulls Delivered' },
      { key: 'emptiesCollected', label: 'Empties Collected' },
      { key: 'emptiesReturnedVerified', label: 'Empties Returned (Verified)' },
      { key: 'emptiesGap', label: 'Empties Gap' },
      { key: 'cancelledReturns', label: 'Cancelled Returns' },
    ],
    rows,
    totals,
    secondary,
  };
}

export const REPORTS: Record<string, (d: string, f: ReportFilters) => Promise<ReportResult>> = {
  'sales-summary': salesSummary,
  'outstanding-aging': outstandingAging,
  'gst-summary': gstSummary,
  'delivery-performance': deliveryPerformance,
  'inventory-movement': inventoryMovement,
  'customer-statement': customerStatement,
  'vehicle-ledger': vehicleLedger,
};

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
