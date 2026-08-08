/**
 * Overview Metrics (2026-08-08) — the Analytics → Overview dashboard.
 *
 * ONE endpoint, all cards, correct + date-scoped. Two hard rules:
 *
 *  1. FLOW vs SNAPSHOT.
 *     - Flow metrics (revenue, collected, delivered, empties collected,
 *       margin) happen DURING a period → summed over [from, to].
 *     - Snapshot metrics (outstanding, overdue, empties-in-market,
 *       shrinkage) are a STATE, read from live balances. We do not store
 *       historical balance snapshots, so these are "as of now" regardless
 *       of the picker — flagged `asOf: 'now'` so the UI can label them
 *       honestly rather than pretend they move with the date range.
 *
 *  2. CARD ≡ REPORT. Every flow metric is sourced from the SAME service
 *     the matching report uses (salesSummary, cylinderRotation, …) or a
 *     query that mirrors it exactly, and is guarded by a consistency test
 *     (overview-consistency.test.ts) asserting card total == report total.
 *     Clicking a card lands on that report showing the identical number.
 *
 * `drillReport` on each metric is the report slug the card links to.
 */
import { prisma } from '../lib/prisma.js';
import { toNum } from '../utils/decimal.js';
import { computeCustomerOverdue } from './paymentService.js';
import { computeAverageLandedCost } from './landedCostService.js';
import {
  salesSummary,
  cylinderRotation,
  customerProfitability,
  REPORTS,
  type ReportFilters,
  type ReportResult,
} from './reportsService.js';

export type MetricKind = 'flow' | 'snapshot';
export type MetricGroup = 'cash' | 'margin' | 'cylinders';

/**
 * OV-6 — three-party flow payload (Corporation → You → Customers).
 * Money on top, cylinders below. Every number here is the SAME primitive
 * the cards use, so the flow graphic can never disagree with them.
 * `money.purchaseReceived` (value of fulls that came IN) is deliberately
 * distinct from `money.cogs` (cost of what was SOLD) — different bases,
 * see anti-pattern #16 / the OV-6 probe. The P&L uses cogs, not purchase.
 */
export interface OverviewFlow {
  money: {
    purchaseReceived: number;    // OMC → You: value of fulls received (range)
    paidToOmc: number;           // You → OMC: purchase payments (range)
    billed: number;              // You → Customers: revenue billed (range)
    collected: number;           // Customers → You: cash received (range)
    cogs: number;                // cost of cylinders SOLD (for the P&L line)
    expenses: number;            // running costs out (range)
    netProfit: number;           // revenue − cogs − expenses
    dueOutstanding: number;      // customers still owe, in-credit (snapshot)
    overdueOutstanding: number;  // customers still owe, overdue (snapshot)
    payableToOmc: number;        // you still owe the Corporation (snapshot)
    /** Aging of the WHOLE outstanding book by age (invoice-issue basis,
     *  matches the Outstanding & Aging report). First bucket = not-yet-due. */
    aging: Array<{ label: string; amount: number; overdue: boolean }>;
  };
  cylinders: {
    fullsReceived: number;       // Corporation → You (range)
    emptiesReturnedToOmc: number;// You → Corporation (range)
    fullsDelivered: number;      // You → Customers (range)
    emptiesCollected: number;    // Customers → You (range)
    netAddedToMarket: number;    // delivered − collected
    inMarket: number;            // cylinders held by customers now (snapshot)
    /** Per-cylinder-type breakdown of the range flows. `fromGodown` =
     *  delivered − received (signed; negative means stock was added). */
    bySku: Array<{
      cylinderType: string;
      fromGodown: number;
      received: number;
      returnedToOmc: number;
      delivered: number;
      collected: number;
    }>;
  };
}

/**
 * OV-7 — Cashflow (period flow). Literal cash in vs cash out this range.
 * DISTINCT from the P&L flow: deposits (refundable) and gross OMC payments
 * DO appear here because real cash moved — they stay OUT of P&L because a
 * deposit is an asset and a load-payment's cost is captured as COGS-when-sold.
 * `collectionsAgainstSales` + `depositsReceived` = `cashIn` (split of the
 * same cash so the bars sum). All figures range-scoped.
 */
export interface OverviewCashflow {
  cashIn: number;                 // Σ all payments received (literal cash)
  depositsReceived: number;       // refundable customer deposits taken (range)
  collectionsAgainstSales: number;// cashIn − depositsReceived (clamped ≥0)
  paidToCorporation: number;      // Σ purchase payments (loads + deposits)
  loadPayments: number;           // → invoice entries
  depositsPaid: number;           // → deposit_invoice entries
  omcUnallocated: number;         // paid but not yet allocated to an entry
  expenses: number;               // operating expenses (range)
  netCashMovement: number;        // cashIn − paidToCorporation − expenses
}

export interface Metric {
  key: string;
  label: string;
  group: MetricGroup;
  kind: MetricKind;
  /** Numeric value; money in ₹, counts in cylinders, rates as 0–100. */
  value: number;
  /** 'money' | 'count' | 'percent' | 'days' — drives formatting in the UI. */
  format: 'money' | 'count' | 'percent' | 'days';
  /** Report slug this card drills into (same number, more detail). */
  drillReport: string | null;
  /** 'range' = obeys the date picker; 'now' = live balance, current state. */
  asOf: 'range' | 'now';
  /** Optional secondary text (e.g. "3 customers > 30d"). */
  sub?: string;
  /** One-line plain-language "how this is computed", shown under the card. */
  description: string;
  /** Card needs OMC purchase data to be meaningful — hidden without it. */
  needsPurchaseData?: boolean;
}

const rangeFilter = (from: string, to: string): ReportFilters => ({ dateFrom: from, dateTo: to });

export async function getOverviewMetrics(
  distributorId: string,
  from: string,
  to: string,
): Promise<{ metrics: Metric[]; hasPurchaseData: boolean; flow: OverviewFlow; cashflow: OverviewCashflow }> {
  const f = rangeFilter(from, to);
  const fromDate = new Date(from);
  const toDate = new Date(to);
  toDate.setHours(23, 59, 59, 999);
  const days = Math.max(1, Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000));

  // ── FLOW: revenue + fulls delivered — reuse salesSummary verbatim ──
  const sales = await salesSummary(distributorId, f);
  const revenue = toNum((sales.totals as { revenue?: number }).revenue ?? 0);
  const fullsDelivered = toNum((sales.totals as { qtyDelivered?: number }).qtyDelivered ?? 0);

  // ── FLOW: collected — payments booked in range (transactionDate) ──
  const paidAgg = await prisma.paymentTransaction.aggregate({
    where: {
      distributorId, deletedAt: null,
      transactionDate: { gte: fromDate, lte: toDate },
    },
    _sum: { amount: true },
  });
  const collected = toNum(paidAgg._sum.amount);

  // ── FLOW: empties collected — collection + returns_collection in range ──
  const collectionEvents = await prisma.inventoryEvent.findMany({
    where: {
      distributorId,
      eventType: { in: ['collection', 'returns_collection'] },
      eventDate: { gte: fromDate, lte: toDate },
    },
    select: { emptiesChange: true, cylinderTypeId: true },
  });
  const emptiesCollected = collectionEvents.reduce((s, e) => s + e.emptiesChange, 0);
  const collectedBySku = new Map<string, number>();
  for (const e of collectionEvents) collectedBySku.set(e.cylinderTypeId, (collectedBySku.get(e.cylinderTypeId) ?? 0) + e.emptiesChange);

  // ── FLOW: utilization = empties collected ÷ fulls delivered ──
  const utilizationPct = fullsDelivered > 0
    ? Math.round((emptiesCollected / fullsDelivered) * 100)
    : 0;

  // ── FLOW: rotation days — reuse cylinderRotation avg cycle ──
  const rotation = await cylinderRotation(distributorId, f);
  const rotationDays = toNum((rotation.totals as { avgCycleDays?: number | string }).avgCycleDays ?? 0);

  // ── FLOW: purchase cost + gross margin (needs landed-cost / purchase data) ──
  // NOTE: PurchaseEntry.purchaseDate is a STRING column (YYYY-MM-DD),
  // so it filters against the raw string range, not Date objects.
  const purchaseCount = await prisma.purchaseEntry.count({
    where: { distributorId, purchaseDate: { gte: from, lte: to } },
  });
  const hasPurchaseData = purchaseCount > 0;

  // ── FLOW (OV-6): value of fulls RECEIVED from OMC + payments TO OMC in
  //    range. Distinct basis from COGS (received vs sold) — kept separate. ──
  const purchaseEntries = await prisma.purchaseEntry.findMany({
    where: { distributorId, deletedAt: null, documentType: 'invoice', purchaseDate: { gte: from, lte: to } },
    select: { items: { select: { fullsReceived: true, unitPrice: true } } },
  });
  let purchaseReceivedValue = 0;
  for (const e of purchaseEntries) for (const it of e.items) purchaseReceivedValue += toNum(it.unitPrice) * it.fullsReceived;
  const omcPayAgg = await prisma.purchasePayment.aggregate({
    where: { distributorId, deletedAt: null, transactionDate: { gte: from, lte: to } },
    _sum: { amount: true },
  });
  const paidToOmc = toNum(omcPayAgg._sum.amount);

  // ── FLOW (OV-6): cylinder movement between YOU and OMC in range ──
  const omcCylEvents = await prisma.inventoryEvent.findMany({
    where: {
      distributorId,
      eventType: { in: ['incoming_fulls', 'outgoing_empties'] },
      eventDate: { gte: fromDate, lte: toDate },
    },
    select: { eventType: true, fullsChange: true, emptiesChange: true, cylinderTypeId: true },
  });
  let fullsReceived = 0, emptiesReturnedToOmc = 0;
  const receivedBySku = new Map<string, number>();
  const returnedBySku = new Map<string, number>();
  for (const e of omcCylEvents) {
    if (e.eventType === 'incoming_fulls') {
      fullsReceived += Math.abs(e.fullsChange);
      receivedBySku.set(e.cylinderTypeId, (receivedBySku.get(e.cylinderTypeId) ?? 0) + Math.abs(e.fullsChange));
    } else {
      emptiesReturnedToOmc += Math.abs(e.emptiesChange);
      returnedBySku.set(e.cylinderTypeId, (returnedBySku.get(e.cylinderTypeId) ?? 0) + Math.abs(e.emptiesChange));
    }
  }

  // ── FLOW (OV-6): fulls delivered per SKU (order basis, matches salesSummary) ──
  const deliveredOrders = await prisma.order.findMany({
    where: {
      distributorId, deletedAt: null,
      status: { in: ['delivered', 'modified_delivered'] },
      deliveryDate: { gte: fromDate, lte: toDate },
    },
    select: { items: { select: { cylinderTypeId: true, deliveredQuantity: true, quantity: true } } },
  });
  const deliveredBySku = new Map<string, number>();
  for (const o of deliveredOrders) for (const it of o.items) {
    deliveredBySku.set(it.cylinderTypeId, (deliveredBySku.get(it.cylinderTypeId) ?? 0) + (it.deliveredQuantity ?? it.quantity));
  }

  // ── FLOW (OV-6): what you still owe OMC (all suppliers, all-time snapshot).
  //    Approximate: Σ (line total + charges − amountPaid); excludes CN/DN
  //    adjustments (a v1 headline — the Corporation ledger has the exact net). ──
  const allPurchaseEntries = await prisma.purchaseEntry.findMany({
    where: { distributorId, deletedAt: null },
    select: { amountPaid: true, items: { select: { unitPrice: true, fullsReceived: true } }, charges: { select: { amount: true } } },
  });
  let payableToOmc = 0;
  for (const e of allPurchaseEntries) {
    const total = e.items.reduce((s, it) => s + toNum(it.unitPrice) * it.fullsReceived, 0)
      + e.charges.reduce((s, ch) => s + toNum(ch.amount), 0);
    payableToOmc += Math.max(0, total - toNum(e.amountPaid));
  }

  // ── CASHFLOW (OV-7): literal cash in vs cash out this range ──
  //   Cash in = all payments received (incl. refundable deposits).
  //   Deposits received (range) split out so bars sum honestly.
  const depAgg = await prisma.customerLedgerEntry.aggregate({
    where: { distributorId, entryType: 'deposit_charged', entryDate: { gte: fromDate, lte: toDate } },
    _sum: { amountDelta: true },
  });
  const depositsReceived = toNum(depAgg._sum.amountDelta);
  const collectionsAgainstSales = Math.max(0, collected - depositsReceived);
  //   Cash out to OMC = purchase payments in range, split load vs deposit
  //   by following each allocation to its PurchaseEntry.documentType.
  const omcPayments = await prisma.purchasePayment.findMany({
    where: { distributorId, deletedAt: null, transactionDate: { gte: from, lte: to } },
    select: { amount: true, allocations: { select: { amount: true, purchaseEntry: { select: { documentType: true } } } } },
  });
  let loadPayments = 0, depositsPaid = 0, omcUnallocated = 0;
  const paidToCorporation = omcPayments.reduce((s, p) => s + toNum(p.amount), 0);
  for (const p of omcPayments) {
    let alloc = 0;
    for (const a of p.allocations) {
      const amt = toNum(a.amount); alloc += amt;
      if (a.purchaseEntry?.documentType === 'deposit_invoice') depositsPaid += amt;
      else loadPayments += amt;
    }
    omcUnallocated += Math.max(0, toNum(p.amount) - alloc);
  }
  // netCashMovement computed at the cashflow object below (needs `expenses`).

  // Cylinder-type names for the per-SKU breakdown.
  const cylTypeRows = await prisma.cylinderType.findMany({ where: { distributorId }, select: { id: true, typeName: true } });
  const cylTypeName = new Map(cylTypeRows.map((c) => [c.id, c.typeName]));

  // ── SNAPSHOT (OV-6): aging of the WHOLE outstanding book by invoice age.
  //    Mirrors reportsService.outstandingAging: derive days-overdue from
  //    issueDate + customer.creditPeriodDays vs now. Buckets: not-due (in
  //    credit) + four overdue bands. This is the pictorial the Flow view shows. ──
  const agingInvoices = await prisma.invoice.findMany({
    where: { distributorId, outstandingAmount: { gt: 0 }, deletedAt: null, status: { not: 'cancelled' } },
    select: { outstandingAmount: true, issueDate: true, customer: { select: { creditPeriodDays: true } } },
  });
  const nowMs = Date.now();
  let agInCredit = 0, ag1_30 = 0, ag31_60 = 0, ag61_90 = 0, ag90 = 0;
  for (const inv of agingInvoices) {
    const credit = inv.customer?.creditPeriodDays ?? 30;
    const dueMs = new Date(inv.issueDate).getTime() + credit * 86_400_000;
    const od = Math.floor((nowMs - dueMs) / 86_400_000);
    const amt = toNum(inv.outstandingAmount);
    if (od <= 0) agInCredit += amt;
    else if (od <= 30) ag1_30 += amt;
    else if (od <= 60) ag31_60 += amt;
    else if (od <= 90) ag61_90 += amt;
    else ag90 += amt;
  }

  const landed = await computeAverageLandedCost(distributorId, undefined, days);
  const cogs = fullsDelivered * landed.avgPerCyl;
  const grossMarginPct = revenue > 0 ? Math.round(((revenue - cogs) / revenue) * 1000) / 10 : 0;
  const purchaseCost = cogs;

  // ── FLOW: operating expenses in range (Expense.expenseDate is a string) ──
  const expenseAgg = await prisma.expense.aggregate({
    where: { distributorId, deletedAt: null, expenseDate: { gte: from, lte: to } },
    _sum: { amount: true },
  });
  const expenses = toNum(expenseAgg._sum.amount);

  // ── FLOW: net profit / net margin — the bottom line ──
  //   Revenue − COGS − Operating expenses = Net profit.
  const netProfit = revenue - cogs - expenses;
  const netMarginPct = revenue > 0 ? Math.round((netProfit / revenue) * 1000) / 10 : 0;

  // ── FLOW: worst-margin customers — reuse N18 ──
  //   FLOOR (fix 2026-08-08): ignore customers below a minimum revenue in the
  //   range. A ₹500 customer with a small stuck balance produces a −155%
  //   ratio that scares without meaning anything — the rupee loss is tiny.
  //   Only accounts material enough to act on surface here.
  const WORST_MARGIN_MIN_REVENUE = 10_000;
  const profit = await customerProfitability(distributorId, f);
  const worstRows = (profit.rows as Array<{ customer?: string; marginPct?: number; revenue?: number }>)
    .filter((r) => typeof r.marginPct === 'number' && (r.revenue ?? 0) >= WORST_MARGIN_MIN_REVENUE)
    .sort((a, b) => (a.marginPct ?? 0) - (b.marginPct ?? 0));
  const worst = worstRows[0];

  // ── SNAPSHOT (current): outstanding, overdue, empties-in-market, shrinkage ──
  const [outstandingAgg, overdueCustomers, balances, emptyPrices] = await Promise.all([
    prisma.invoice.aggregate({
      where: { distributorId, outstandingAmount: { gt: 0 }, deletedAt: null },
      _sum: { outstandingAmount: true },
    }),
    prisma.customer.findMany({
      where: { distributorId, deletedAt: null, invoices: { some: { outstandingAmount: { gt: 0 }, deletedAt: null } } },
      select: { id: true },
    }),
    prisma.customerInventoryBalance.findMany({
      where: { customer: { distributorId, deletedAt: null } },
      select: { withCustomerQty: true, missingQty: true, cylinderTypeId: true },
    }),
    prisma.emptyCylinderPrice.findMany({ where: { distributorId } }),
  ]);
  const totalOutstanding = toNum(outstandingAgg._sum.outstandingAmount);
  const overduePer = await Promise.all(overdueCustomers.map((c) => computeCustomerOverdue(distributorId, c.id)));
  const overdue = overduePer.reduce((s, a) => s + a, 0);
  const overdueCount = overduePer.filter((a) => a > 0).length;
  const due = Math.max(0, totalOutstanding - overdue); // within-credit only (no double-count)

  const priceMap = new Map(emptyPrices.map((p) => [p.cylinderTypeId, toNum(p.emptyCylinderPrice)]));
  let emptiesValue = 0;
  let emptiesStuck = 0;
  let shrinkageQty = 0;
  let shrinkageValue = 0;
  for (const b of balances) {
    const price = priceMap.get(b.cylinderTypeId) ?? 0;
    // Clamp per-row: a NEGATIVE withCustomerQty means the customer returned
    // more than they hold (a credit position), not that they hold negative
    // value. "Value out in the market" can never be negative — count only
    // positive holdings. Same for missing.
    const held = Math.max(0, b.withCustomerQty);
    const missing = Math.max(0, b.missingQty);
    emptiesValue += held * price;
    emptiesStuck += held;
    shrinkageQty += missing;
    shrinkageValue += missing * price;
  }
  const amountInMarket = due + overdue + emptiesValue; // total field exposure

  // Collection days (DSO) — "how many days, on average, to get paid after
  // billing". FIX (2026-08-08): use a FIXED trailing 90-day sales rate for
  // the denominator, NOT the picked range. Otherwise a 1-day or a 1-year
  // range swings the number wildly even though it's an "as of today"
  // reading (a 90→189 jump is what surfaced this). Trailing-90 is the
  // standard, stable basis.
  const trail90From = new Date();
  trail90From.setDate(trail90From.getDate() - 90);
  const trail90 = await prisma.order.aggregate({
    where: {
      distributorId, deletedAt: null,
      status: { in: ['delivered', 'modified_delivered'] },
      deliveryDate: { gte: trail90From, lte: new Date() },
    },
    _sum: { totalAmount: true },
  });
  const revenue90 = toNum(trail90._sum.totalAmount);
  const collectionDays = revenue90 > 0 ? Math.round(totalOutstanding / (revenue90 / 90)) : 0;

  const metrics: Metric[] = [
    // CASH
    { key: 'revenue', label: 'Revenue billed', group: 'cash', kind: 'flow', value: +revenue.toFixed(2), format: 'money', drillReport: 'daily-sales', asOf: 'range', description: 'Total value of orders delivered in this period.' },
    { key: 'collected', label: 'Collected', group: 'cash', kind: 'flow', value: +collected.toFixed(2), format: 'money', drillReport: 'payment-collections', asOf: 'range', description: 'Payments actually received from customers in this period.' },
    { key: 'due', label: 'Due (in credit)', group: 'cash', kind: 'snapshot', value: +due.toFixed(2), format: 'money', drillReport: 'outstanding-aging', asOf: 'now', description: 'Unpaid bills still within the customer’s credit period — not late yet.' },
    { key: 'overdue', label: 'Overdue', group: 'cash', kind: 'snapshot', value: +overdue.toFixed(2), format: 'money', drillReport: 'outstanding-aging', asOf: 'now', sub: overdueCount > 0 ? `${overdueCount} customer${overdueCount === 1 ? '' : 's'} overdue` : undefined, description: 'Unpaid bills past their due date. Chase these first.' },
    { key: 'amountInMarket', label: 'Amount in Market', group: 'cash', kind: 'snapshot', value: +amountInMarket.toFixed(2), format: 'money', drillReport: 'outstanding-aging', asOf: 'now', sub: 'cash owed + cylinder deposits out', description: 'Everything of yours out in the field = Due + Overdue + deposit value of cylinders customers hold.' },
    { key: 'collectionDays', label: 'Avg Collection Days', group: 'cash', kind: 'snapshot', value: collectionDays, format: 'days', drillReport: 'outstanding-aging', asOf: 'now', description: 'On average, how many days to get paid after billing (based on the last 90 days of sales). Lower is better.' },
    // MARGIN — the P&L chain: Revenue − Purchase cost − Expenses = Net profit
    { key: 'purchaseCost', label: 'Purchase cost (OMC)', group: 'margin', kind: 'flow', value: +purchaseCost.toFixed(2), format: 'money', drillReport: 'corp-landed-cost-trend', asOf: 'range', needsPurchaseData: true, description: 'What the delivered cylinders cost you from the corporation (landed cost × cylinders delivered).' },
    { key: 'grossMargin', label: 'Gross Margin', group: 'margin', kind: 'flow', value: grossMarginPct, format: 'percent', drillReport: 'corp-purchase-vs-sale-margin', asOf: 'range', needsPurchaseData: true, description: '(Revenue − Purchase cost) ÷ Revenue. Profit before running costs.' },
    { key: 'expenses', label: 'Expenses', group: 'margin', kind: 'flow', value: +expenses.toFixed(2), format: 'money', drillReport: 'expense-register', asOf: 'range', description: 'Total running costs booked in this period (fuel, salary, rent, etc.).' },
    { key: 'netMargin', label: 'Net Margin', group: 'margin', kind: 'flow', value: netMarginPct, format: 'percent', drillReport: 'expense-register', asOf: 'range', needsPurchaseData: true, sub: `Net profit ${netProfit >= 0 ? '' : '−'}₹${Math.abs(Math.round(netProfit)).toLocaleString('en-IN')}`, description: '(Revenue − Purchase cost − Expenses) ÷ Revenue. The true bottom line.' },
    { key: 'worstMargin', label: 'Worst-margin customer', group: 'margin', kind: 'flow', value: worst?.marginPct ?? 0, format: 'percent', drillReport: 'customer-profitability', asOf: 'range', sub: worst?.customer, description: 'The account with the thinnest (or negative) margin — worth reviewing or re-pricing. Ignores tiny accounts under ₹10k.' },
    // CYLINDERS
    { key: 'fullsDelivered', label: 'Fulls delivered', group: 'cylinders', kind: 'flow', value: fullsDelivered, format: 'count', drillReport: 'inventory-movement', asOf: 'range', description: 'Full cylinders delivered to customers in this period.' },
    { key: 'emptiesCollected', label: 'Empties collected', group: 'cylinders', kind: 'flow', value: emptiesCollected, format: 'count', drillReport: 'inventory-movement', asOf: 'range', description: 'Empty cylinders collected back from customers in this period.' },
    { key: 'utilization', label: 'Utilization', group: 'cylinders', kind: 'flow', value: utilizationPct, format: 'percent', drillReport: 'cylinder-rotation', asOf: 'range', description: 'Empties collected ÷ fulls delivered. Low means cylinders are stuck with customers.' },
    { key: 'rotationDays', label: 'Rotation days', group: 'cylinders', kind: 'flow', value: rotationDays, format: 'days', drillReport: 'cylinder-rotation', asOf: 'range', description: 'Average days a cylinder takes to come back as an empty. Lower is better.' },
    { key: 'emptiesValue', label: 'Empties value in market', group: 'cylinders', kind: 'snapshot', value: +emptiesValue.toFixed(2), format: 'money', drillReport: 'cylinder-rotation', asOf: 'now', sub: `${emptiesStuck} cylinders out`, description: 'Deposit value of cylinders customers are holding right now (cylinders out × deposit price).' },
    { key: 'shrinkage', label: 'Shrinkage', group: 'cylinders', kind: 'snapshot', value: shrinkageQty, format: 'count', drillReport: 'stock-adjustment-audit', asOf: 'now', sub: shrinkageValue > 0 ? `≈ ₹${Math.round(shrinkageValue).toLocaleString('en-IN')} lost` : undefined, description: 'Cylinders recorded as missing or lost across customer balances.' },
  ];

  // Cards that need OMC purchase data (cost/gross/net margin) are hidden
  // when the tenant records no purchases — Expenses + worst-margin still show.
  const filtered = hasPurchaseData ? metrics : metrics.filter((m) => !m.needsPurchaseData);

  // ── OV-6 three-party flow (Corporation → You → Customers) ──
  const flow: OverviewFlow = {
    money: {
      purchaseReceived: +purchaseReceivedValue.toFixed(2),
      paidToOmc: +paidToOmc.toFixed(2),
      billed: +revenue.toFixed(2),
      collected: +collected.toFixed(2),
      cogs: +cogs.toFixed(2),
      expenses: +expenses.toFixed(2),
      netProfit: +netProfit.toFixed(2),
      dueOutstanding: +due.toFixed(2),
      overdueOutstanding: +overdue.toFixed(2),
      payableToOmc: +payableToOmc.toFixed(2),
      aging: [
        { label: 'In credit', amount: +agInCredit.toFixed(2), overdue: false },
        { label: '1–30 days', amount: +ag1_30.toFixed(2), overdue: true },
        { label: '31–60 days', amount: +ag31_60.toFixed(2), overdue: true },
        { label: '61–90 days', amount: +ag61_90.toFixed(2), overdue: true },
        { label: '90+ days', amount: +ag90.toFixed(2), overdue: true },
      ],
    },
    cylinders: {
      fullsReceived,
      emptiesReturnedToOmc,
      fullsDelivered,
      emptiesCollected,
      netAddedToMarket: fullsDelivered - emptiesCollected,
      inMarket: emptiesStuck,
      bySku: [...new Set([
        ...receivedBySku.keys(), ...returnedBySku.keys(), ...deliveredBySku.keys(), ...collectedBySku.keys(),
      ])]
        .map((id) => {
          const received = receivedBySku.get(id) ?? 0;
          const delivered = deliveredBySku.get(id) ?? 0;
          return {
            cylinderType: cylTypeName.get(id) ?? '—',
            fromGodown: delivered - received,
            received,
            returnedToOmc: returnedBySku.get(id) ?? 0,
            delivered,
            collected: collectedBySku.get(id) ?? 0,
          };
        })
        .sort((a, b) => b.delivered - a.delivered),
    },
  };

  const cashflow: OverviewCashflow = {
    cashIn: +collected.toFixed(2),
    depositsReceived: +depositsReceived.toFixed(2),
    collectionsAgainstSales: +collectionsAgainstSales.toFixed(2),
    paidToCorporation: +paidToCorporation.toFixed(2),
    loadPayments: +loadPayments.toFixed(2),
    depositsPaid: +depositsPaid.toFixed(2),
    omcUnallocated: +omcUnallocated.toFixed(2),
    expenses: +expenses.toFixed(2),
    netCashMovement: +(collected - paidToCorporation - expenses).toFixed(2),
  };

  return { metrics: filtered, hasPurchaseData, flow, cashflow };
}

// ── OV-3 — "Show raw data" drawer ──────────────────────────────────────
//
// Each metric's raw rows ARE the rows of the report it links into — so the
// drawer, the card, and the full report all show the same underlying data.
// We simply run that report over the same range. Keeping this delegation
// (rather than re-querying) is what guarantees the drawer can never disagree
// with the report.
const METRIC_REPORT: Record<string, string> = {
  revenue: 'daily-sales',
  collected: 'payment-collections',
  due: 'outstanding-aging',
  overdue: 'outstanding-aging',
  amountInMarket: 'outstanding-aging',
  collectionDays: 'outstanding-aging',
  purchaseCost: 'corp-landed-cost-trend',
  grossMargin: 'corp-purchase-vs-sale-margin',
  expenses: 'expense-register',
  netMargin: 'expense-register',
  worstMargin: 'customer-profitability',
  fullsDelivered: 'inventory-movement',
  emptiesCollected: 'inventory-movement',
  utilization: 'cylinder-rotation',
  rotationDays: 'cylinder-rotation',
  emptiesValue: 'cylinder-rotation',
  shrinkage: 'stock-adjustment-audit',
};

export async function getMetricRawData(
  distributorId: string,
  metricKey: string,
  from: string,
  to: string,
): Promise<ReportResult | null> {
  const slug = METRIC_REPORT[metricKey];
  if (!slug) return null;
  const fn = REPORTS[slug];
  if (!fn) return null;
  return fn(distributorId, rangeFilter(from, to));
}
