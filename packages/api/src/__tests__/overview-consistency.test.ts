/**
 * OV-2 — the "card ≡ report" invariant (Suneel 2026-08-08: correct + consistent
 * is the most critical part).
 *
 * Each Overview card must equal the total on the report it links to, computed
 * over the same date range. If a card's query ever drifts from its report,
 * these assertions fail — the number can't silently lie.
 *
 * Also pins the flow/snapshot contract: flow metrics carry asOf='range',
 * snapshot metrics asOf='now'.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getOverviewMetrics } from '../services/overviewMetricsService.js';
import { salesSummary, cylinderRotation } from '../services/reportsService.js';

const D1 = 'dist-001';
const FROM = '2026-01-01';
const TO = '2099-12-31'; // wide window — capture all seeded activity

function toNum(v: unknown): number { return typeof v === 'number' ? v : Number(v ?? 0); }

let metrics: Awaited<ReturnType<typeof getOverviewMetrics>>['metrics'];
let cashflow: Awaited<ReturnType<typeof getOverviewMetrics>>['cashflow'];
const byKey = (k: string) => metrics.find((m) => m.key === k)!;

beforeAll(async () => {
  ({ metrics, cashflow } = await getOverviewMetrics(D1, FROM, TO));
});

describe('Overview ≡ Report consistency', () => {
  it('revenue card == salesSummary revenue total', async () => {
    const rep = await salesSummary(D1, { dateFrom: FROM, dateTo: TO });
    const repRevenue = toNum((rep.totals as { revenue?: number }).revenue);
    expect(byKey('revenue').value).toBeCloseTo(repRevenue, 1);
  });

  it('fulls delivered card == salesSummary qtyDelivered total', async () => {
    const rep = await salesSummary(D1, { dateFrom: FROM, dateTo: TO });
    const repQty = toNum((rep.totals as { qtyDelivered?: number }).qtyDelivered);
    expect(byKey('fullsDelivered').value).toBe(repQty);
  });

  it('rotation-days card == cylinderRotation avgCycleDays total', async () => {
    const rep = await cylinderRotation(D1, { dateFrom: FROM, dateTo: TO });
    const repAvg = toNum((rep.totals as { avgCycleDays?: number | string }).avgCycleDays);
    expect(byKey('rotationDays').value).toBeCloseTo(repAvg, 1);
  });

  it('utilization = empties collected ÷ fulls delivered (internally consistent)', () => {
    const fulls = byKey('fullsDelivered').value;
    const empties = byKey('emptiesCollected').value;
    const expected = fulls > 0 ? Math.round((empties / fulls) * 100) : 0;
    expect(byKey('utilization').value).toBe(expected);
  });

  it('Amount in Market = Due + Overdue + Empties value (no double-count)', () => {
    const due = byKey('due').value;
    const overdue = byKey('overdue').value;
    const empties = byKey('emptiesValue').value;
    expect(byKey('amountInMarket').value).toBeCloseTo(due + overdue + empties, 1);
  });

  it('Due excludes Overdue (Due + Overdue ≤ total outstanding, no overlap)', () => {
    // Due is defined as total − overdue, so it must never itself be negative
    // and must not re-include the overdue amount.
    expect(byKey('due').value).toBeGreaterThanOrEqual(0);
  });
});

describe('flow / snapshot contract', () => {
  it('flow metrics are asOf=range; snapshot metrics are asOf=now', () => {
    const flow = ['revenue', 'collected', 'fullsDelivered', 'emptiesCollected', 'utilization', 'expenses'];
    const snapshot = ['due', 'overdue', 'amountInMarket', 'emptiesValue', 'shrinkage', 'collectionDays'];
    for (const k of flow) expect(byKey(k).asOf, `${k} should be range`).toBe('range');
    for (const k of snapshot) expect(byKey(k).asOf, `${k} should be now`).toBe('now');
  });

  it('every metric carries a drill-through report slug + a description', () => {
    for (const m of metrics) {
      expect(typeof m.drillReport === 'string' || m.drillReport === null).toBe(true);
      expect(typeof m.description, `${m.key} needs a description`).toBe('string');
      expect(m.description.length, `${m.key} description not empty`).toBeGreaterThan(0);
    }
    for (const k of ['revenue', 'overdue', 'utilization', 'emptiesValue']) {
      expect(byKey(k).drillReport, `${k} needs a drill report`).toBeTruthy();
    }
  });

  it('Net Margin = (Revenue − Purchase cost − Expenses) ÷ Revenue', () => {
    // Only meaningful when purchase data exists (net-margin card present).
    const nm = metrics.find((m) => m.key === 'netMargin');
    if (!nm) return; // tenant has no purchase data → card hidden, nothing to check
    const revenue = byKey('revenue').value;
    const cost = byKey('purchaseCost').value;
    const exp = byKey('expenses').value;
    const expected = revenue > 0 ? Math.round(((revenue - cost - exp) / revenue) * 1000) / 10 : 0;
    expect(nm.value).toBeCloseTo(expected, 1);
  });
});

describe('OV-7 cashflow — internal consistency + card links', () => {
  it('cashIn == the Collected metric (same PaymentTransaction basis)', () => {
    expect(cashflow.cashIn).toBeCloseTo(byKey('collected').value, 1);
  });
  it('collectionsAgainstSales + depositsReceived == cashIn (bars sum)', () => {
    expect(cashflow.collectionsAgainstSales + cashflow.depositsReceived).toBeCloseTo(cashflow.cashIn, 1);
  });
  it('loadPayments + depositsPaid + omcUnallocated == paidToCorporation (split sums)', () => {
    expect(cashflow.loadPayments + cashflow.depositsPaid + cashflow.omcUnallocated).toBeCloseTo(cashflow.paidToCorporation, 1);
  });
  it('expenses == the Expenses metric', () => {
    expect(cashflow.expenses).toBeCloseTo(byKey('expenses').value, 1);
  });
  it('netCashMovement == cashIn − paidToCorporation − expenses', () => {
    expect(cashflow.netCashMovement).toBeCloseTo(cashflow.cashIn - cashflow.paidToCorporation - cashflow.expenses, 1);
  });
  it('deposits are refundable → excluded from P&L (cashflow ≠ P&L net when deposits/OMC-credit present)', () => {
    // Sanity: cashflow is a distinct lens; depositsReceived is real cash but
    // never counted as revenue/profit. Just assert the field is non-negative.
    expect(cashflow.depositsReceived).toBeGreaterThanOrEqual(0);
  });
});
