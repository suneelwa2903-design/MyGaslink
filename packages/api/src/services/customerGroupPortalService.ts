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

/** Local-TZ start-of-current-month + right-now. */
function currentMonthRange(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return { start, end: now };
}

// ─── 5A — Dashboard ──────────────────────────────────────────────────────

export interface GroupDashboardResponse {
  totalOutstanding: number;
  totalOverdue: number;
  cylindersThisMonth: Array<{
    cylinderTypeId: string;
    cylinderTypeName: string;
    quantity: number;
  }>;
  aging: {
    bucket0_30: number;
    bucket31_60: number;
    bucket60plus: number;
  };
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
}

export async function getDashboard(
  distributorId: string,
  visibleCustomerIds: string[],
): Promise<GroupDashboardResponse> {
  if (visibleCustomerIds.length === 0) {
    return {
      totalOutstanding: 0,
      totalOverdue: 0,
      cylindersThisMonth: [],
      aging: { bucket0_30: 0, bucket31_60: 0, bucket60plus: 0 },
      properties: [],
    };
  }

  const { start: monthStart, end: monthEnd } = currentMonthRange();

  // Fire everything that doesn't depend on customer list first. The
  // per-property FIFO overdue call cluster runs last because it fans
  // out to N calls (see HQ-PORTAL-BRAINSTORM.md §1a — call-N is the
  // recommended v1 approach; batch form is a v2 optimisation).
  const [
    outstandingAgg,
    cylinderAgg,
    customers,
    outstandingByCust,
    lastOrderByCust,
    lastInvoiceByCust,
  ] = await Promise.all([
    prisma.invoice.aggregate({
      where: {
        distributorId,
        customerId: { in: visibleCustomerIds },
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
          customerId: { in: visibleCustomerIds },
          status: { in: ['delivered', 'modified_delivered'] as $Enums.OrderStatus[] },
          deliveryDate: { gte: monthStart, lte: monthEnd },
          deletedAt: null,
        },
      },
    }),
    prisma.customer.findMany({
      where: { id: { in: visibleCustomerIds }, distributorId, deletedAt: null },
      select: { id: true, customerName: true, businessName: true, gstin: true },
    }),
    prisma.invoice.groupBy({
      by: ['customerId'],
      where: {
        distributorId,
        customerId: { in: visibleCustomerIds },
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

  // Resolve cylinderTypeId → name in one round trip.
  const cylinderTypeIds = cylinderAgg.map((a) => a.cylinderTypeId);
  const cylinderTypes = cylinderTypeIds.length === 0
    ? []
    : await prisma.cylinderType.findMany({
        where: { id: { in: cylinderTypeIds } },
        select: { id: true, typeName: true },
      });
  const cylinderNameMap = new Map(cylinderTypes.map((c) => [c.id, c.typeName]));

  // Per-property overdue: call the canonical FIFO overdue once per
  // member. 3-50 members × <10ms each on indexed columns → sub-second
  // dashboard load per HQ-PORTAL-BRAINSTORM.md §6 sanity check.
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
    customerName: c.customerName,
    businessName: c.businessName,
    gstin: c.gstin,
    outstanding: outstandingMap.get(c.id) ?? 0,
    lastDeliveryDate: lastDeliveryMap.get(c.id)?.toISOString() ?? null,
    lastInvoiceDate: lastInvoiceMap.get(c.id)?.toISOString() ?? null,
    isOverdue: (overdueByCust.get(c.id) ?? 0) > 0,
  }));

  // Aging via the extended outstandingAging (now accepts customerIds).
  // The report returns rows per customer with bucket columns; sum them
  // for the group-level aging bar.
  const agingReport = await outstandingAging(distributorId, { customerIds: visibleCustomerIds });
  let bucket0_30 = 0, bucket31_60 = 0, bucket60plus = 0;
  for (const row of agingReport.rows) {
    // row shape per reportsService: numeric columns keyed by header
    // labels like '0-30 days'. Sum defensively — any variation in the
    // header name (or if the report emits additional buckets) won't
    // crash the dashboard; unmapped columns are ignored.
    const values = row as Record<string, unknown>;
    const num = (k: string) => (typeof values[k] === 'number' ? (values[k] as number) : 0);
    bucket0_30 += num('0-30 days') + num('bucket0_30');
    bucket31_60 += num('31-60 days') + num('bucket31_60');
    bucket60plus += num('60+ days') + num('bucket60plus');
  }

  const totalOverdue = Array.from(overdueByCust.values()).reduce((s, n) => s + n, 0);

  return {
    totalOutstanding: toNum(outstandingAgg._sum.outstandingAmount),
    totalOverdue: Math.round(totalOverdue * 100) / 100,
    cylindersThisMonth: cylinderAgg.map((a) => ({
      cylinderTypeId: a.cylinderTypeId,
      cylinderTypeName: cylinderNameMap.get(a.cylinderTypeId) ?? 'Unknown',
      quantity: a._sum.deliveredQuantity ?? 0,
    })),
    aging: {
      bucket0_30: Math.round(bucket0_30 * 100) / 100,
      bucket31_60: Math.round(bucket31_60 * 100) / 100,
      bucket60plus: Math.round(bucket60plus * 100) / 100,
    },
    properties,
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
    data: orders.map((o) => mapOrder(o)),
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
    data: invoices.map((i) => mapInvoice(i)),
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
    totalDebited: number;
    totalReceived: number;
    netOutstanding: number;
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
): Promise<GroupLedgerResponse> {
  const custFilter = resolveCustomerIdFilter(visibleCustomerIds, filters.customerId);
  const effectiveIds =
    typeof custFilter === 'string' ? [custFilter] : custFilter.in;

  if (effectiveIds.length === 0) {
    return { rows: [], totals: { totalDebited: 0, totalReceived: 0, netOutstanding: 0 } };
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
    for (const r of rows) {
      mergedRows.push({
        customerId,
        customerName: customer.customerName,
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
      customerName: p.customer?.customerName ?? 'Deleted customer',
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
        customerName: m.customer.customerName,
        businessName: m.customer.businessName,
        gstin: m.customer.gstin,
        customerType: m.customer.customerType,
      })),
  };
}
