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

  // Load customer pending empties for every (customer, cyl) pair this
  // driver served in the range, so each row can show the customer's
  // cumulative pending count for that cylinder type.
  const customerIds = [...new Set(usable.map((o) => o.customerId))];
  const balances = customerIds.length
    ? await prisma.customerInventoryBalance.findMany({
        where: { customerId: { in: customerIds } },
        select: { customerId: true, cylinderTypeId: true, withCustomerQty: true },
      })
    : [];
  const pendingByCustCyl = new Map<string, number>();
  for (const b of balances) {
    pendingByCustCyl.set(`${b.customerId}|${b.cylinderTypeId}`, b.withCustomerQty);
  }

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
    fullsDelivered: number;
    emptiesCollected: number;
    pendingEmpties: number;
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
    const cylMix = new Map<string, { name: string; qty: number }>();
    let totalFulls = 0;
    let totalEmpties = 0;
    let maxPending = 0;
    for (const it of o.items) {
      const key = it.cylinderTypeId ?? '__unknown__';
      const name = it.cylinderType?.typeName ?? '—';
      const qty = it.deliveredQuantity ?? it.quantity ?? 0;
      const empties = it.emptiesCollected ?? 0;
      totalFulls += qty;
      totalEmpties += empties;
      const cur = cylMix.get(key) ?? { name, qty: 0 };
      cur.qty += qty;
      cylMix.set(key, cur);
      const pending = pendingByCustCyl.get(`${o.customerId}|${key}`) ?? 0;
      if (pending > maxPending) maxPending = pending;
    }
    const cylinders = [...cylMix.values()]
      .filter((c) => c.qty > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => `${c.qty}×${c.name}`)
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
      fullsDelivered: totalFulls,
      emptiesCollected: totalEmpties,
      pendingEmpties: maxPending,
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
      { key: 'cylinders', label: 'Cylinders' },
      { key: 'fullsDelivered', label: 'F Del' },
      { key: 'emptiesCollected', label: 'E Coll' },
      { key: 'pendingEmpties', label: 'E Pend' },
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
      fullsDelivered: totalsFulls,
      emptiesCollected: totalsEmpties,
      pendingEmpties: '',
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
  let carryForward = 0;
  for (const e of allEntries) {
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
    running += num(e.amountDelta);
    rows.push({
      date: dayKey(new Date(e.entryDate)),
      type: isEmptiesReturn ? 'Empties Return' : e.entryType.replace(/_entry$/, ''),
      narration: e.narration ?? '',
      debit: isEmptiesReturn ? '' : (num(e.amountDelta) > 0 ? num(e.amountDelta) : 0),
      credit: isEmptiesReturn ? '' : (num(e.amountDelta) < 0 ? -num(e.amountDelta) : 0),
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
// stock event. A depot-level Corporation-loads table is returned separately (secondary).
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

  // ── Corporation loads received (depot-level secondary table) ───────────────
  type CorporationRow = { date: string; documentNumber: string; cylinderType: string; quantity: number };
  const corporationMap = new Map<string, CorporationRow>();
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
      const cur = corporationMap.get(key) ?? { date: docDate, documentNumber: docNo, cylinderType: e.cylinderType?.typeName ?? '—', quantity: 0 };
      cur.quantity += e.fullsChange;
      corporationMap.set(key, cur);
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

  const corporationRows = [...corporationMap.values()].sort((a, b) => (a.date === b.date ? a.documentNumber.localeCompare(b.documentNumber) : a.date.localeCompare(b.date)));
  const secondary: ReportTable = {
    title: 'Corporation Loads Received (Depot)',
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'documentNumber', label: 'Document No' },
      { key: 'cylinderType', label: 'Cylinder Type' },
      { key: 'quantity', label: 'Fulls Received' },
    ],
    rows: corporationRows,
    totals: { date: 'TOTAL', documentNumber: '', cylinderType: '', quantity: corporationRows.reduce((s, r) => s + r.quantity, 0) },
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

export const REPORTS: Record<string, (d: string, f: ReportFilters) => Promise<ReportResult>> = {
  'sales-summary': salesSummary,
  'outstanding-aging': outstandingAging,
  'gst-summary': gstSummary,
  'delivery-performance': deliveryPerformance,
  'inventory-movement': inventoryMovement,
  'customer-statement': customerStatement,
  'vehicle-ledger': vehicleLedger,
  'payment-collections': paymentCollections,
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
