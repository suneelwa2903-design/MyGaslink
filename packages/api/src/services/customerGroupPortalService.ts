/**
 * Feature A (2026-07-15): READ-ONLY HQ customer-group portal service.
 *
 * Every function takes `(distributorId, visibleCustomerIds, filters?)`.
 * Both scoping clauses are applied on EVERY query — never one without
 * the other (anti-pattern #13 double-scope). visibleCustomerIds is
 * resolved by requireGroupAccess middleware (already tenant-verified),
 * so passing it here without re-verifying its tenant is safe.
 *
 * Property filter (filters.customerId) MUST be validated against
 * visibleCustomerIds first — a customer_hq client could send a
 * customerId from a different group. When the check fails: throw 403.
 *
 * Narrow `select` on every query. No `include: true` on any relation.
 *
 * No writes anywhere in this file. The corresponding router
 * (customerGroupPortal.ts) blocks non-GET methods at the top-level
 * middleware for defence-in-depth.
 */
import { prisma } from '../lib/prisma.js';
import type { Prisma, $Enums } from '@prisma/client';
import { toNum } from '../utils/decimal.js';
import {
  processLedgerEntries,
  loadInvoicesForLedger,
  loadEmptyPricesForLedger,
  computeCustomerOverdue,
  type LedgerProcessingInput,
} from './paymentService.js';
import { outstandingAging } from './reportsService.js';
import { mapOrder, mapInvoice, mapCustomerInvoiceDetail } from '../utils/mappers.js';

export class GroupPortalError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'GroupPortalError';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the effective customerId filter for a query. Throws 403 when
 * the client supplied a property filter that isn't in the group's
 * visible-customer set — this is the primary group-isolation guard.
 * Returns either a single string (single-property filter) or a
 * `{ in: [...] }` clause (whole group).
 */
function resolveCustomerIdFilter(
  visibleCustomerIds: string[],
  requestedCustomerId?: string,
): string | { in: string[] } {
  if (requestedCustomerId) {
    if (!visibleCustomerIds.includes(requestedCustomerId)) {
      throw new GroupPortalError(
        'The requested property is not in your group',
        403,
      );
    }
    return requestedCustomerId;
  }
  return { in: visibleCustomerIds };
}

// ─── 5A — Dashboard ──────────────────────────────────────────────────────

export interface GroupDashboardFilters {
  /** Restrict the dashboard to a single group member. Empty/undefined → whole group. */
  customerId?: string;
  /** ISO date (yyyy-mm-dd) inclusive lower bound for activity metrics. */
  from?: string;
  /** ISO date (yyyy-mm-dd) inclusive upper bound for activity metrics. */
  to?: string;
}

export interface GroupDashboardResponse {
  // State metrics — always current (ignore date range but honour customerId)
  totalOutstanding: number;
  totalOverdue: number;
  aging: {
    bucket0_30: number;
    bucket31_60: number;
    bucket60plus: number;
  };
  // In-range activity — filtered by date range AND customerId
  activity: {
    range: { from: string; to: string };
    fullsDelivered: Array<{
      cylinderTypeId: string;
      cylinderTypeName: string;
      quantity: number;
    }>;
    emptiesCollected: Array<{
      cylinderTypeId: string;
      cylinderTypeName: string;
      quantity: number;
    }>;
    amountBilled: number;
    paymentsReceived: number;
  };
  // Empties currently HELD by customers — state-current running balance
  // per cylinder type. Scoped by customerId. This is the "how many empty
  // cylinders is each hotel sitting on right now" number the HQ user
  // asked for.
  emptiesWithClients: Array<{
    cylinderTypeId: string;
    cylinderTypeName: string;
    capacity: number;
    quantity: number;
  }>;
  properties: Array<{
    customerId: string;
    customerName: string;
    businessName: string | null;
    gstin: string | null;
    outstanding: number;
    lastDeliveryDate: string | null;
    lastInvoiceDate: string | null;
    isOverdue: boolean;
  }>;
  // Echo the effective filter so the client can render "Viewing: X /
  // From Y to Z" without re-computing.
  filters: {
    customerId: string | null;
    from: string;
    to: string;
  };
  /**
   * @deprecated 2026-07-19 — use `activity.fullsDelivered` instead. Kept
   * for one release so a stale cached client doesn't crash.
   */
  cylindersThisMonth: Array<{
    cylinderTypeId: string;
    cylinderTypeName: string;
    quantity: number;
  }>;
}

/** Parse an ISO date string, returning null when invalid/empty. */
function parseIsoDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

/** Local-TZ end-of-day for the given ISO date. */
function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/** Resolve the effective date range: explicit filter → provided range;
 *  otherwise default to the current month. */
function resolveDashboardRange(filters?: GroupDashboardFilters): { start: Date; end: Date; fromIso: string; toIso: string } {
  const now = new Date();
  const fromParsed = parseIsoDate(filters?.from);
  const toParsed = parseIsoDate(filters?.to);
  if (fromParsed && toParsed) {
    return {
      start: fromParsed,
      end: endOfDay(toParsed),
      fromIso: filters!.from!,
      toIso: filters!.to!,
    };
  }
  // Fallback: current month → today
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start, end: now, fromIso: iso(start), toIso: iso(now) };
}

/**
 * 2026-07-20: `displayNames` map (customerId → alias) is threaded into
 * every LIST surface (Property column context — dashboard properties,
 * ledger rows, payments/orders/invoices lists, profile picker) so the
 * HQ user sees a consistent short label everywhere. Detail views
 * (getGroupOrderById, getGroupInvoiceById) are intentionally EXCLUDED
 * — an invoice/order detail is a legal document and must show the
 * canonical customer name.
 *
 * Aliases originate from CustomerGroupMember.displayName and are
 * populated by requireGroupAccess middleware. When the map is
 * undefined or misses a customerId, callers fall back to
 * `customer.customerName` — every reader uses `map?.get(cid) ?? name`.
 */
export type DisplayNameMap = ReadonlyMap<string, string> | undefined;

/** Small helper — keeps the fallback identical everywhere. */
function resolveDisplayName(
  map: DisplayNameMap,
  customerId: string,
  fallback: string,
): string {
  return map?.get(customerId) ?? fallback;
}

export async function getDashboard(
  distributorId: string,
  visibleCustomerIds: string[],
  filters?: GroupDashboardFilters,
  displayNames?: DisplayNameMap,
): Promise<GroupDashboardResponse> {
  const range = resolveDashboardRange(filters);
  const emptyResponse: GroupDashboardResponse = {
    totalOutstanding: 0,
    totalOverdue: 0,
    aging: { bucket0_30: 0, bucket31_60: 0, bucket60plus: 0 },
    activity: {
      range: { from: range.fromIso, to: range.toIso },
      fullsDelivered: [],
      emptiesCollected: [],
      amountBilled: 0,
      paymentsReceived: 0,
    },
    emptiesWithClients: [],
    properties: [],
    filters: {
      customerId: filters?.customerId?.trim() || null,
      from: range.fromIso,
      to: range.toIso,
    },
    cylindersThisMonth: [],
  };
  if (visibleCustomerIds.length === 0) return emptyResponse;

  // Effective customer scope: if the caller requested a single property,
  // validate it's inside the group and use only that; else the whole
  // group's visible set. Same guard resolveCustomerIdFilter uses on
  // orders/invoices/etc — cross-tenant leak protection.
  const custFilter = resolveCustomerIdFilter(visibleCustomerIds, filters?.customerId);
  const effectiveIds = typeof custFilter === 'string' ? [custFilter] : custFilter.in;
  if (effectiveIds.length === 0) return emptyResponse;

  const { start: monthStart, end: monthEnd } = range;

  // Fire everything that doesn't depend on customer list first. The
  // per-property FIFO overdue call cluster runs last because it fans
  // out to N calls (see HQ-PORTAL-BRAINSTORM.md §1a — call-N is the
  // recommended v1 approach; batch form is a v2 optimisation).
  //
  // 2026-07-19 filter refresh — the effective customerId set is
  // `effectiveIds` (either the whole group or the single-property
  // filter). Date range is `monthStart`/`monthEnd` (either the
  // caller's from/to or the current-month default).
  const [
    outstandingAgg,
    fullsAgg,
    emptiesCollectedAgg,
    inventoryBalances,
    amountBilledAgg,
    paymentsAgg,
    customers,
    outstandingByCust,
    lastOrderByCust,
    lastInvoiceByCust,
  ] = await Promise.all([
    prisma.invoice.aggregate({
      where: {
        distributorId,
        customerId: { in: effectiveIds },
        outstandingAmount: { gt: 0 },
        status: { in: ['issued', 'partially_paid', 'overdue'] as $Enums.InvoiceStatus[] },
        deletedAt: null,
      },
      _sum: { outstandingAmount: true },
    }),
    prisma.orderItem.groupBy({
      by: ['cylinderTypeId'],
      _sum: { deliveredQuantity: true },
      where: {
        order: {
          distributorId,
          customerId: { in: effectiveIds },
          status: { in: ['delivered', 'modified_delivered'] as $Enums.OrderStatus[] },
          deliveryDate: { gte: monthStart, lte: monthEnd },
          deletedAt: null,
        },
      },
    }),
    prisma.orderItem.groupBy({
      by: ['cylinderTypeId'],
      _sum: { emptiesCollected: true },
      where: {
        order: {
          distributorId,
          customerId: { in: effectiveIds },
          status: { in: ['delivered', 'modified_delivered'] as $Enums.OrderStatus[] },
          deliveryDate: { gte: monthStart, lte: monthEnd },
          deletedAt: null,
        },
      },
    }),
    // State-current: how many empty cylinders EACH member holds RIGHT
    // NOW. Not date-range filtered — the balance is the running total.
    // Aggregated across the effective customer set, grouped by
    // cylinder type at the JS layer since `distinct + groupBy` doesn't
    // apply cleanly with the customer join.
    prisma.customerInventoryBalance.findMany({
      where: {
        customerId: { in: effectiveIds },
        customer: { distributorId, deletedAt: null },
      },
      select: {
        withCustomerQty: true,
        cylinderType: { select: { id: true, typeName: true, capacity: true } },
      },
    }),
    prisma.invoice.aggregate({
      where: {
        distributorId,
        customerId: { in: effectiveIds },
        issueDate: { gte: monthStart, lte: monthEnd },
        status: { in: ['issued', 'partially_paid', 'paid', 'overdue'] as $Enums.InvoiceStatus[] },
        deletedAt: null,
      },
      _sum: { totalAmount: true },
    }),
    prisma.paymentTransaction.aggregate({
      where: {
        distributorId,
        customerId: { in: effectiveIds },
        transactionDate: { gte: monthStart, lte: monthEnd },
        deletedAt: null,
      },
      _sum: { amount: true },
    }),
    prisma.customer.findMany({
      where: { id: { in: visibleCustomerIds }, distributorId, deletedAt: null },
      select: { id: true, customerName: true, businessName: true, gstin: true },
    }),
    prisma.invoice.groupBy({
      by: ['customerId'],
      where: {
        distributorId,
        customerId: { in: effectiveIds },
        outstandingAmount: { gt: 0 },
        status: { in: ['issued', 'partially_paid', 'overdue'] as $Enums.InvoiceStatus[] },
        deletedAt: null,
      },
      _sum: { outstandingAmount: true },
    }),
    prisma.order.groupBy({
      by: ['customerId'],
      where: {
        distributorId,
        customerId: { in: visibleCustomerIds },
        status: { in: ['delivered', 'modified_delivered'] as $Enums.OrderStatus[] },
        deletedAt: null,
      },
      _max: { deliveryDate: true },
    }),
    prisma.invoice.groupBy({
      by: ['customerId'],
      where: {
        distributorId,
        customerId: { in: visibleCustomerIds },
        deletedAt: null,
      },
      _max: { issueDate: true },
    }),
  ]);

  // Resolve cylinderTypeId → name in one round trip. Merge IDs from
  // the delivered-fulls, empties-collected, and inventory-balance
  // aggregations so every cylinder-type reference has a display name.
  const cylinderTypeIds = Array.from(new Set([
    ...fullsAgg.map((a) => a.cylinderTypeId),
    ...emptiesCollectedAgg.map((a) => a.cylinderTypeId),
    ...inventoryBalances.map((b) => b.cylinderType.id),
  ]));
  const cylinderTypes = cylinderTypeIds.length === 0
    ? []
    : await prisma.cylinderType.findMany({
        where: { id: { in: cylinderTypeIds } },
        select: { id: true, typeName: true },
      });
  const cylinderNameMap = new Map(cylinderTypes.map((c) => [c.id, c.typeName]));

  // Per-property overdue: call the canonical FIFO overdue once per
  // member. 3-50 members × <10ms each on indexed columns → sub-second
  // dashboard load per HQ-PORTAL-BRAINSTORM.md §6 sanity check. Runs
  // over EVERY member of visibleCustomerIds (not effectiveIds) so the
  // property rollup at the bottom always lists every property, even
  // when a customerId filter is active — the filter narrows KPIs, it
  // doesn't hide the roster.
  const overdueByCust = new Map<string, number>();
  await Promise.all(
    visibleCustomerIds.map(async (cid) => {
      const amount = await computeCustomerOverdue(distributorId, cid, new Date());
      overdueByCust.set(cid, amount);
    }),
  );

  const outstandingMap = new Map(
    outstandingByCust.map((o) => [o.customerId, toNum(o._sum.outstandingAmount)]),
  );
  const lastDeliveryMap = new Map(
    lastOrderByCust.map((o) => [o.customerId, o._max.deliveryDate]),
  );
  const lastInvoiceMap = new Map(
    lastInvoiceByCust.map((o) => [o.customerId, o._max.issueDate]),
  );

  const properties = customers.map((c) => ({
    customerId: c.id,
    customerName: resolveDisplayName(displayNames, c.id, c.customerName),
    businessName: c.businessName,
    gstin: c.gstin,
    outstanding: outstandingMap.get(c.id) ?? 0,
    lastDeliveryDate: lastDeliveryMap.get(c.id)?.toISOString() ?? null,
    lastInvoiceDate: lastInvoiceMap.get(c.id)?.toISOString() ?? null,
    isOverdue: (overdueByCust.get(c.id) ?? 0) > 0,
  }));

  // Aging via the extended outstandingAging (now accepts customerIds).
  // The report returns rows per customer with bucket columns; sum them
  // for the group-level aging bar. Scoped by effectiveIds so a single-
  // property filter also narrows the aging summary.
  //
  // 2026-07-19 BUG FIX: this used to look up row keys '0-30 days' /
  // 'bucket0_30' etc. Neither name exists — reportsService.outstandingAging
  // actually emits `b0_30` / `b31_60` / `b60plus` (see reportsService.ts
  // line 254 onward). Result: every group's aging summary was silently
  // 0/0/0 on the Dashboard while the aging TAB (which reads the correct
  // keys) showed real data. hq-portal.test.ts now pins this so the
  // regression can't come back. Use the `totals` row when present —
  // it's already summed across customers by reportsService.
  let bucket0_30 = 0, bucket31_60 = 0, bucket60plus = 0;
  const agingReport = await outstandingAging(distributorId, { customerIds: effectiveIds });
  if (agingReport.totals) {
    const t = agingReport.totals as Record<string, unknown>;
    bucket0_30 = typeof t.b0_30 === 'number' ? t.b0_30 : 0;
    bucket31_60 = typeof t.b31_60 === 'number' ? t.b31_60 : 0;
    bucket60plus = typeof t.b60plus === 'number' ? t.b60plus : 0;
  } else {
    for (const row of agingReport.rows) {
      const r = row as Record<string, unknown>;
      bucket0_30 += typeof r.b0_30 === 'number' ? r.b0_30 : 0;
      bucket31_60 += typeof r.b31_60 === 'number' ? r.b31_60 : 0;
      bucket60plus += typeof r.b60plus === 'number' ? r.b60plus : 0;
    }
  }

  const totalOverdue = effectiveIds.reduce((s, id) => s + (overdueByCust.get(id) ?? 0), 0);

  // ── Aggregate the state-current empties balance per cylinder type
  //    across the effective customer set. When a single customer is
  //    filtered, the sum is that customer's balance. When "all
  //    properties" is selected, it's the group-wide total per type.
  const emptiesWithClientsMap = new Map<string, { typeName: string; capacity: number; qty: number }>();
  for (const b of inventoryBalances) {
    const key = b.cylinderType.id;
    const cur = emptiesWithClientsMap.get(key);
    if (cur) {
      cur.qty += b.withCustomerQty;
    } else {
      emptiesWithClientsMap.set(key, {
        typeName: b.cylinderType.typeName,
        capacity: b.cylinderType.capacity,
        qty: b.withCustomerQty,
      });
    }
  }
  const emptiesWithClients = Array.from(emptiesWithClientsMap.entries()).map(([id, v]) => ({
    cylinderTypeId: id,
    cylinderTypeName: v.typeName,
    capacity: v.capacity,
    quantity: v.qty,
  })).sort((a, b) => a.cylinderTypeName.localeCompare(b.cylinderTypeName));

  const fullsDelivered = fullsAgg.map((a) => ({
    cylinderTypeId: a.cylinderTypeId,
    cylinderTypeName: cylinderNameMap.get(a.cylinderTypeId) ?? 'Unknown',
    quantity: a._sum.deliveredQuantity ?? 0,
  })).sort((a, b) => a.cylinderTypeName.localeCompare(b.cylinderTypeName));

  const emptiesCollected = emptiesCollectedAgg.map((a) => ({
    cylinderTypeId: a.cylinderTypeId,
    cylinderTypeName: cylinderNameMap.get(a.cylinderTypeId) ?? 'Unknown',
    quantity: a._sum.emptiesCollected ?? 0,
  })).sort((a, b) => a.cylinderTypeName.localeCompare(b.cylinderTypeName));

  return {
    totalOutstanding: toNum(outstandingAgg._sum.outstandingAmount),
    totalOverdue: Math.round(totalOverdue * 100) / 100,
    aging: {
      bucket0_30: Math.round(bucket0_30 * 100) / 100,
      bucket31_60: Math.round(bucket31_60 * 100) / 100,
      bucket60plus: Math.round(bucket60plus * 100) / 100,
    },
    activity: {
      range: { from: range.fromIso, to: range.toIso },
      fullsDelivered,
      emptiesCollected,
      amountBilled: Math.round(toNum(amountBilledAgg._sum.totalAmount) * 100) / 100,
      paymentsReceived: Math.round(toNum(paymentsAgg._sum.amount) * 100) / 100,
    },
    emptiesWithClients,
    properties,
    filters: {
      customerId: typeof custFilter === 'string' ? custFilter : null,
      from: range.fromIso,
      to: range.toIso,
    },
    // Deprecated alias — same shape as pre-filter cylindersThisMonth so
    // a stale client that hasn't upgraded still renders. Both point at
    // the same data because activity range defaults to the current
    // month when no filter is passed.
    cylindersThisMonth: fullsDelivered,
  };
}

// ─── 5B — Orders ─────────────────────────────────────────────────────────

export interface GroupOrdersFilters {
  customerId?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export async function getGroupOrders(
  distributorId: string,
  visibleCustomerIds: string[],
  filters: GroupOrdersFilters,
  displayNames?: DisplayNameMap,
) {
  const custFilter = resolveCustomerIdFilter(visibleCustomerIds, filters.customerId);
  const where: Prisma.OrderWhereInput = {
    distributorId,
    customerId: custFilter,
    deletedAt: null,
  };
  if (filters.status) {
    const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean) as $Enums.OrderStatus[];
    where.status = statuses.length > 1 ? { in: statuses } : statuses[0];
  }
  if (filters.from || filters.to) {
    where.deliveryDate = {};
    if (filters.from) where.deliveryDate.gte = new Date(filters.from);
    if (filters.to) {
      const toEnd = new Date(filters.to);
      toEnd.setHours(23, 59, 59, 999);
      where.deliveryDate.lte = toEnd;
    }
  }
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        items: { include: { cylinderType: { select: { typeName: true } } } },
        driver: { select: { driverName: true } },
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            outstandingAmount: true,
            irn: true,
          },
        },
        customer: {
          select: {
            id: true,
            customerName: true,
            businessName: true,
            customerType: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);
  return {
    // Post-map alias: mapOrder is shared with other surfaces (customer
    // portal, admin) — we overwrite only on the group-portal path so
    // the underlying mapper stays unchanged.
    data: orders.map((o) => {
      const mapped = mapOrder(o) as Record<string, unknown> | null;
      if (mapped && o.customerId && displayNames?.has(o.customerId)) {
        const alias = displayNames.get(o.customerId)!;
        mapped.customerName = alias;
        const nested = mapped.customer as Record<string, unknown> | undefined;
        if (nested) nested.customerName = alias;
      }
      return mapped;
    }),
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

/**
 * Single-order detail for the HQ portal. Verifies the order belongs to
 * a visible customer before returning — cross-group access blocked
 * with 404 (no info leak — same shape as tenant-isolation).
 *
 * 2026-07-20 note: intentionally NOT aliased — an order detail is a
 * legal-adjacent view (customer name, address, GSTIN) and must show
 * the canonical customer record.
 */
export async function getGroupOrderById(
  distributorId: string,
  visibleCustomerIds: string[],
  orderId: string,
) {
  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      distributorId,
      customerId: { in: visibleCustomerIds },
      deletedAt: null,
    },
    include: {
      items: { include: { cylinderType: { select: { typeName: true } } } },
      driver: { select: { driverName: true } },
      invoice: {
        select: {
          id: true, invoiceNumber: true, status: true,
          outstandingAmount: true, irn: true,
        },
      },
      customer: {
        select: {
          id: true, customerName: true, businessName: true, gstin: true,
        },
      },
    },
  });
  if (!order) throw new GroupPortalError('Order not found', 404);
  return mapOrder(order);
}

// ─── 5C — Invoices ───────────────────────────────────────────────────────

// Same "hide invoices whose linked order is still in-flight" business
// rule as customerPortalService.INVOICE_VISIBILITY_OR — preserved
// verbatim for the group view. If the source rule changes over there,
// keep this in sync.
const IN_FLIGHT_ORDER_STATUSES: $Enums.OrderStatus[] = [
  'pending_driver_assignment',
  'pending_dispatch',
  'pending_delivery',
];
const INVOICE_VISIBILITY_OR: Prisma.InvoiceWhereInput[] = [
  { orderId: null },
  { order: { status: { notIn: IN_FLIGHT_ORDER_STATUSES } } },
];

export interface GroupInvoicesFilters {
  customerId?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export async function getGroupInvoices(
  distributorId: string,
  visibleCustomerIds: string[],
  filters: GroupInvoicesFilters,
  displayNames?: DisplayNameMap,
) {
  const custFilter = resolveCustomerIdFilter(visibleCustomerIds, filters.customerId);
  const where: Prisma.InvoiceWhereInput = {
    distributorId,
    customerId: custFilter,
    deletedAt: null,
    isGaslinkBilling: false,
    OR: INVOICE_VISIBILITY_OR,
  };
  if (filters.status) where.status = filters.status as $Enums.InvoiceStatus;
  if (filters.from || filters.to) {
    where.issueDate = {};
    if (filters.from) where.issueDate.gte = new Date(filters.from);
    if (filters.to) {
      const toEnd = new Date(filters.to);
      toEnd.setHours(23, 59, 59, 999);
      where.issueDate.lte = toEnd;
    }
  }
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: {
        items: { include: { cylinderType: { select: { typeName: true } } } },
        customer: {
          select: {
            id: true,
            customerName: true,
            businessName: true,
            gstin: true,
          },
        },
        // Feature A (2026-07-15): distributor.gstin is the sellerGstin
        // that mapCustomerInvoiceDetail (soon to be reused per-invoice)
        // surfaces for GSTR-2A/2B reconciliation. Narrow select.
        distributor: { select: { gstin: true } },
        order: {
          select: { orderNumber: true, status: true },
        },
      },
      orderBy: { issueDate: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.invoice.count({ where }),
  ]);
  return {
    // Post-map alias for the LIST view Property column. Detail view
    // (getGroupInvoiceById below) keeps the legal name.
    data: invoices.map((i) => {
      const mapped = mapInvoice(i) as Record<string, unknown> | null;
      if (mapped && i.customerId && displayNames?.has(i.customerId)) {
        const alias = displayNames.get(i.customerId)!;
        const nested = mapped.customer as Record<string, unknown> | undefined;
        if (nested) nested.customerName = alias;
      }
      return mapped;
    }),
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

/**
 * Single invoice detail with the full customer-facing shape including
 * sellerGstin (the CA reconciliation gap this feature fills). Reuses
 * the existing customerPortal mapper so the wire shape stays
 * consistent between single-customer and HQ-group callers.
 *
 * 2026-07-20 note: intentionally NOT aliased — an invoice is a legal
 * document; the bill-to name must be the canonical customer record.
 */
export async function getGroupInvoiceById(
  distributorId: string,
  visibleCustomerIds: string[],
  invoiceId: string,
) {
  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      distributorId,
      customerId: { in: visibleCustomerIds },
      deletedAt: null,
    },
    include: {
      items: { include: { cylinderType: { select: { typeName: true } } } },
      customer: {
        select: {
          customerName: true,
          gstin: true,
          billingAddressLine1: true,
          billingAddressLine2: true,
          billingCity: true,
          billingState: true,
          billingPincode: true,
        },
      },
      distributor: { select: { gstin: true } },
      order: { select: { status: true } },
      paymentAllocations: {
        include: {
          payment: {
            select: {
              id: true, transactionDate: true,
              paymentMethod: true, referenceNumber: true,
            },
          },
        },
      },
    },
  });
  if (!invoice) throw new GroupPortalError('Invoice not found', 404);
  return mapCustomerInvoiceDetail(invoice);
}

// ─── 5D — Consolidated ledger ────────────────────────────────────────────

export interface GroupLedgerFilters {
  customerId?: string;
  from?: string;
  to?: string;
}

export interface GroupLedgerRow {
  customerId: string;
  customerName: string;
  orderDate: string;
  cylinderType: string;
  fullCylsDelivered: number;
  amount: number;
  emptyCylsCollected: number;
  pendingEmptyCyls: number;
  emptyCylsCost: number;
  totalAmount: number;
  receivedAmount: number;
  dueAmount: number;
  creditDays: number;
  overDueAmount: number;
  narration: string | null;
  kind: string | null;
}

export interface GroupLedgerResponse {
  rows: GroupLedgerRow[];
  totals: {
    // Legacy cumulative-through-`to` fields — kept for back-compat.
    // 2026-07-20 confusion: these were labelled "(period)" on the PDF
    // but actually included pre-range entries. New consumers should
    // use openingBalance + periodDebited + periodReceived + closingBalance
    // instead — those reconcile to the visible rows.
    totalDebited: number;
    totalReceived: number;
    netOutstanding: number;
    // 2026-07-20 — true accountant's statement shape. Guaranteed
    // identity: openingBalance + periodDebited − periodReceived
    // === closingBalance. Overdue is a subset of closingBalance.
    openingBalance: number;
    periodDebited: number;
    periodReceived: number;
    closingBalance: number;
    overdue: number;
  };
}

/**
 * Consolidated ledger merged chronologically across all group members,
 * with a `customerId` + `customerName` column on every row so the
 * property is clear. Running balance stays PER-CUSTOMER (never
 * aggregated across the group — different customers have different
 * creditPeriodDays clocks, so a merged running total would be
 * meaningless — per HQ-PORTAL-BRAINSTORM.md §4).
 *
 * Data-loading pattern: one fetch of all entries across all members,
 * one fetch of related invoices, one fetch of empty prices; then
 * bucket by customerId and call the stateless processLedgerEntries
 * once per bucket against the shared fetches. Zero N+1 round-trips.
 */
export async function getGroupLedger(
  distributorId: string,
  visibleCustomerIds: string[],
  filters: GroupLedgerFilters,
  displayNames?: DisplayNameMap,
): Promise<GroupLedgerResponse> {
  const custFilter = resolveCustomerIdFilter(visibleCustomerIds, filters.customerId);
  const effectiveIds =
    typeof custFilter === 'string' ? [custFilter] : custFilter.in;

  if (effectiveIds.length === 0) {
    return {
      rows: [],
      totals: {
        totalDebited: 0,
        totalReceived: 0,
        netOutstanding: 0,
        openingBalance: 0,
        periodDebited: 0,
        periodReceived: 0,
        closingBalance: 0,
        overdue: 0,
      },
    };
  }

  // 1. All ledger entries across the effective customer set (single query).
  const allEntries = await prisma.customerLedgerEntry.findMany({
    where: {
      distributorId,
      customerId: { in: effectiveIds },
    },
    orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
  });

  // 2. Invoice-detail map + empty-price map — both reused from
  // paymentService so the processing behaviour stays identical.
  const [invoiceMap, emptyPriceMap, customers] = await Promise.all([
    loadInvoicesForLedger(allEntries),
    loadEmptyPricesForLedger(distributorId),
    prisma.customer.findMany({
      where: { id: { in: effectiveIds } },
      select: { id: true, customerName: true, creditPeriodDays: true },
    }),
  ]);
  const customerMap = new Map(customers.map((c) => [c.id, c]));

  // 3. Bucket entries by customerId, then run processLedgerEntries
  // once per bucket. Each customer's running balance / FIFO / opening-
  // balance state stays isolated in its own call.
  const bucketed = new Map<string, typeof allEntries>();
  for (const e of allEntries) {
    const bucket = bucketed.get(e.customerId) ?? [];
    bucket.push(e);
    bucketed.set(e.customerId, bucket);
  }

  const mergedRows: GroupLedgerRow[] = [];
  let totalDebited = 0;
  let totalReceived = 0;
  let openingBalance = 0;
  let periodDebited = 0;
  let periodReceived = 0;
  let overdue = 0;

  for (const [customerId, bucketEntries] of bucketed) {
    const customer = customerMap.get(customerId);
    if (!customer) continue; // customer soft-deleted since being added
    const input: LedgerProcessingInput = {
      entries: bucketEntries,
      invoiceMap,
      emptyPriceMap,
      creditPeriodDays: customer.creditPeriodDays,
      range: { from: filters.from, to: filters.to },
    };
    const { rows, summary } = processLedgerEntries(input);
    const effectiveName = resolveDisplayName(displayNames, customerId, customer.customerName);
    for (const r of rows) {
      mergedRows.push({
        customerId,
        customerName: effectiveName,
        orderDate: r.orderDate,
        cylinderType: r.cylinderType,
        fullCylsDelivered: r.fullCylsDelivered,
        amount: r.amount,
        emptyCylsCollected: r.emptyCylsCollected,
        pendingEmptyCyls: r.pendingEmptyCyls,
        emptyCylsCost: r.emptyCylsCost,
        totalAmount: r.totalAmount,
        receivedAmount: r.receivedAmount,
        dueAmount: r.dueAmount,
        creditDays: r.creditDays,
        overDueAmount: r.overDueAmount,
        narration: r.narration ?? null,
        kind: r.kind ?? null,
      });
    }
    totalDebited += summary.totalAmount;
    totalReceived += summary.receivedAmount;
    openingBalance += summary.openingBalance ?? 0;
    periodDebited += summary.periodDebited ?? 0;
    periodReceived += summary.periodReceived ?? 0;
    overdue += summary.overdueAmount ?? 0;
  }

  // Global chronological sort — within the same day, keep the per-
  // customer order (stable sort in modern V8).
  mergedRows.sort((a, b) => a.orderDate.localeCompare(b.orderDate));

  return {
    rows: mergedRows,
    totals: {
      totalDebited: Math.round(totalDebited * 100) / 100,
      totalReceived: Math.round(totalReceived * 100) / 100,
      netOutstanding: Math.round((totalDebited - totalReceived) * 100) / 100,
      openingBalance: Math.round(openingBalance * 100) / 100,
      periodDebited: Math.round(periodDebited * 100) / 100,
      periodReceived: Math.round(periodReceived * 100) / 100,
      // Closing = Opening + Period Debited − Period Received. Same as
      // (totalDebited − totalReceived) i.e. netOutstanding — kept as
      // an explicit field so tile-renderers don't have to reconstruct
      // the identity themselves.
      closingBalance: Math.round((openingBalance + periodDebited - periodReceived) * 100) / 100,
      overdue: Math.round(overdue * 100) / 100,
    },
  };
}

// ─── 5E — Payments ───────────────────────────────────────────────────────

export interface GroupPaymentsFilters {
  customerId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export async function getGroupPayments(
  distributorId: string,
  visibleCustomerIds: string[],
  filters: GroupPaymentsFilters,
  displayNames?: DisplayNameMap,
) {
  const custFilter = resolveCustomerIdFilter(visibleCustomerIds, filters.customerId);
  const where: Prisma.PaymentTransactionWhereInput = {
    distributorId,
    customerId: custFilter,
    deletedAt: null,
  };
  if (filters.from || filters.to) {
    where.transactionDate = {};
    if (filters.from) where.transactionDate.gte = new Date(filters.from);
    if (filters.to) {
      const toEnd = new Date(filters.to);
      toEnd.setHours(23, 59, 59, 999);
      where.transactionDate.lte = toEnd;
    }
  }
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const [payments, total] = await Promise.all([
    prisma.paymentTransaction.findMany({
      where,
      include: {
        customer: { select: { customerName: true, businessName: true } },
        allocations: {
          include: {
            invoice: { select: { invoiceNumber: true } },
          },
        },
      },
      orderBy: { transactionDate: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.paymentTransaction.count({ where }),
  ]);
  return {
    data: payments.map((p) => ({
      paymentId: p.id,
      customerId: p.customerId,
      customerName: resolveDisplayName(
        displayNames,
        p.customerId ?? '',
        p.customer?.customerName ?? 'Deleted customer',
      ),
      businessName: p.customer?.businessName ?? null,
      amount: toNum(p.amount),
      paymentMethod: p.paymentMethod,
      transactionDate: p.transactionDate.toISOString(),
      referenceNumber: p.referenceNumber,
      notes: p.notes,
      invoicesApplied: p.allocations.map((a) => ({
        invoiceNumber: a.invoice?.invoiceNumber ?? null,
        amount: toNum(a.allocatedAmount),
      })),
    })),
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

// ─── 5F — Aging ──────────────────────────────────────────────────────────

/**
 * Per-property aging report. Thin wrapper around outstandingAging
 * (which now accepts customerIds — extended in the sibling
 * "sellerGstin + customerIds filter" commit). Returns the report
 * as-is so the client renders it with the existing aging-table
 * component. Distributor-wide behaviour is preserved by the report;
 * this wrapper just constrains the customer set.
 */
export async function getGroupAging(
  distributorId: string,
  visibleCustomerIds: string[],
) {
  if (visibleCustomerIds.length === 0) {
    return { rows: [], columns: [] };
  }
  return outstandingAging(distributorId, { customerIds: visibleCustomerIds });
}

// ─── Profile ─────────────────────────────────────────────────────────────

export interface GroupProfileResponse {
  group: {
    id: string;
    name: string;
    createdAt: string;
  };
  distributor: {
    businessName: string;
    phone: string | null;
    email: string | null;
  };
  members: Array<{
    customerId: string;
    customerName: string;
    businessName: string | null;
    gstin: string | null;
    customerType: string;
  }>;
}

export async function getProfile(
  distributorId: string,
  groupId: string,
): Promise<GroupProfileResponse> {
  const group = await prisma.customerGroup.findFirst({
    where: { id: groupId, distributorId, deletedAt: null },
    include: {
      members: {
        // 2026-07-20: pull displayName so the property picker labels
        // match the ledger Property column (single source of truth for
        // "what the HQ user sees for this property").
        include: {
          customer: {
            select: {
              id: true, customerName: true, businessName: true,
              gstin: true, customerType: true, deletedAt: true,
            },
          },
        },
      },
      distributor: {
        select: { businessName: true, phone: true, email: true },
      },
    },
  });
  if (!group) throw new GroupPortalError('Group not found', 404);
  return {
    group: {
      id: group.id,
      name: group.name,
      createdAt: group.createdAt.toISOString(),
    },
    distributor: {
      businessName: group.distributor.businessName,
      phone: group.distributor.phone,
      email: group.distributor.email,
    },
    members: group.members
      .filter((m) => !m.customer.deletedAt)
      .map((m) => ({
        customerId: m.customer.id,
        customerName: m.displayName ?? m.customer.customerName,
        businessName: m.customer.businessName,
        gstin: m.customer.gstin,
        customerType: m.customer.customerType,
      })),
  };
}
