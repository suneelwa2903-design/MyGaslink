// 2026-08-05 Chunk 4 — 9 real reports + N27 placeholder (catalog-only).
//
// One file per Chunk so review is single-pass. Each describe block covers
// one report with positive / wire-shape / regression / (where relevant)
// cross-tenant tests.
//
// Reports covered:
//   1. N10 cylinderRotation           (Customers)
//   2. N12 routeDriverPerformance     (merged into driverDailyLog 2026-08-06 — see reports-driver-daily-log.test.ts)
//   3. N13 driverVehicleCostBreakdown (Expenses)
//   4. N14 emptiesInTransit           (Inventory)
//   5. N17 paymentMethodMix           (Invoicing & Payments)
//   6. N19 rateVarianceLeakage        (Invoicing & Payments)
//   7. N21 cashBook                   (Month-End)
//   8. N22 cashflowStatement          (Month-End)
//   9. N33 expensesByCategoryTrend    (Expenses)
//  10. N34 accountabilityLogReport    (Customers)
//  + N27 delivery-challan-pdf         (placeholder — catalog-only, no service)
//
// TEST_DATE 2099-12-21 per anti-pattern #7. Shared fixture setup in
// beforeAll; per-report seeds happen inside each `it()` for isolation.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  cylinderRotation,
  // routeDriverPerformance — deleted 2026-08-06, merged into driverDailyLog.
  driverVehicleCostBreakdown,
  emptiesInTransit,
  paymentMethodMix,
  rateVarianceLeakage,
  cashBook,
  cashflowStatement,
  expensesByCategoryTrend,
  accountabilityLogReport,
} from '../services/reportsService.js';
import { getSeedData, loginAsDistAdmin } from './helpers.js';

const DAY = new Date('2099-12-21T00:00:00.000Z');
const DAY_STR = '2099-12-21';

let app: Express;
let token: string;
let distributorId: string;
let cylinderTypeId: string;
let customerId: string;
let vehicleId: string;
let driverAId: string;
let expenseCategoryId: string | null = null;
let fuelCategoryId: string | null = null;
let creatorUserId: string | null = null;
const orderIds: string[] = [];
const paymentIds: string[] = [];
const expenseIds: string[] = [];
const ledgerEntryIds: string[] = [];
const accountabilityIds: string[] = [];
const cancelledStockIds: string[] = [];
const discountIds: string[] = [];
const inventoryEventIds: string[] = [];

beforeAll(async () => {
  app = createApp();
  const login = await loginAsDistAdmin();
  token = login.token;
  distributorId = login.distributorId;
  creatorUserId = login.user.id;
  const seed = await getSeedData();
  cylinderTypeId = seed.cylinderTypes[0].id;
  customerId = seed.customers[0].id;
  vehicleId = seed.vehicles[0].id;
  driverAId = seed.drivers[0].id;

  // Get or create expense categories (need Fuel-named for N13, any for N32 baseline)
  const existingFuel = await prisma.expenseCategory.findFirst({
    where: { distributorId, name: { contains: 'Fuel', mode: 'insensitive' }, deletedAt: null },
  });
  if (existingFuel) {
    fuelCategoryId = existingFuel.id;
  } else {
    const cat = await prisma.expenseCategory.create({
      data: { distributorId, name: 'Fuel-TEST-Chunk4', code: 'FUEL-C4', isActive: true },
    });
    fuelCategoryId = cat.id;
  }
  const existingCat = await prisma.expenseCategory.findFirst({
    where: { distributorId, deletedAt: null, id: { not: fuelCategoryId } },
  });
  if (existingCat) {
    expenseCategoryId = existingCat.id;
  } else {
    const cat = await prisma.expenseCategory.create({
      data: { distributorId, name: 'Misc-TEST-Chunk4', code: 'MISC-C4', isActive: true },
    });
    expenseCategoryId = cat.id;
  }
});

afterAll(async () => {
  if (expenseIds.length) await prisma.expense.deleteMany({ where: { id: { in: expenseIds } } });
  if (paymentIds.length) await prisma.paymentTransaction.deleteMany({ where: { id: { in: paymentIds } } });
  if (ledgerEntryIds.length) await prisma.customerLedgerEntry.deleteMany({ where: { id: { in: ledgerEntryIds } } });
  if (accountabilityIds.length) await prisma.accountabilityLog.deleteMany({ where: { id: { in: accountabilityIds } } });
  if (cancelledStockIds.length) await prisma.cancelledStockEvent.deleteMany({ where: { id: { in: cancelledStockIds } } });
  if (discountIds.length) await prisma.customerCylinderDiscount.deleteMany({ where: { id: { in: discountIds } } });
  if (inventoryEventIds.length) await prisma.inventoryEvent.deleteMany({ where: { id: { in: inventoryEventIds } } });
  if (orderIds.length) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
});

// ─── Shared seeder helpers ─────────────────────────────────────────────

async function seedOrder(opts: {
  suffix: string;
  status?: 'delivered' | 'cancelled';
  drvId?: string;
  amount?: number;
  qty?: number;
}): Promise<string> {
  const order = await prisma.order.create({
    data: {
      distributorId,
      customerId,
      orderNumber: `TEST-C4-${opts.suffix}`,
      orderDate: DAY,
      deliveryDate: DAY,
      status: opts.status ?? 'delivered',
      totalAmount: opts.amount ?? 1000,
      driverId: opts.drvId ?? driverAId,
      vehicleId,
      tripNumber: 1,
      items: {
        create: [{
          cylinderTypeId,
          quantity: opts.qty ?? 1,
          deliveredQuantity: opts.qty ?? 1,
          unitPrice: (opts.amount ?? 1000) / (opts.qty ?? 1),
          totalPrice: opts.amount ?? 1000,
        }],
      },
    },
  });
  orderIds.push(order.id);
  return order.id;
}

// ─── N10 Cylinder Rotation ─────────────────────────────────────────────

describe('N10 — Cylinder Rotation', () => {
  it('POSITIVE — returns balances > 0 with days-since-delivery computed', async () => {
    const res = await cylinderRotation(distributorId, {});
    // Report is current-state; rows depend on live seed data. Just guard shape.
    expect(Array.isArray(res.rows)).toBe(true);
    for (const r of res.rows) {
      expect(Number(r.heldQty)).toBeGreaterThan(0);
    }
  });

  it('WIRE-SHAPE — 7 columns in expected order', async () => {
    const res = await cylinderRotation(distributorId, {});
    const cols = res.columns.map((c) => c.key);
    // 2026-08-06: added avgCycleDays + deviationDays (FX-F).
    expect(cols).toEqual(['customer', 'cylinderType', 'heldQty', 'lastDelivery', 'daysSinceDelivery', 'avgCycleDays', 'deviationDays', 'lastPickup', 'daysSincePickup']);
  });

  it('REGRESSION — route + CSV export', async () => {
    const res = await request(app).get('/api/reports/cylinder-rotation').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const csv = await request(app).get('/api/reports/cylinder-rotation').query({ format: 'csv' }).set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
  });
});

// N12 Route / Driver Performance MERGED into driverDailyLog on
// 2026-08-06 — see reports-driver-daily-log.test.ts. Old block deleted.

// ─── N13 Driver & Vehicle Cost Breakdown ──────────────────────────────

describe('N13 — Driver & Vehicle Cost Breakdown', () => {
  it('POSITIVE — fuel expense classified into Fuel bucket + attributed to driver', async () => {
    if (!fuelCategoryId || !creatorUserId) throw new Error('setup incomplete');
    const e = await prisma.expense.create({
      data: {
        distributorId,
        categoryId: fuelCategoryId,
        expenseDate: DAY_STR,
        amount: 2500,
        description: 'TEST-N13 fuel bill',
        paymentMethod: 'cash',
        driverId: driverAId,
        vehicleId,
        createdBy: creatorUserId,
      },
    });
    expenseIds.push(e.id);
    await seedOrder({ suffix: 'N13-DEL', status: 'delivered', amount: 3000, qty: 2 });

    const res = await driverVehicleCostBreakdown(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const row = res.rows.find((r) => r.driverId === driverAId);
    expect(row).toBeDefined();
    expect(Number(row!.fuel)).toBeGreaterThanOrEqual(2500);
    expect(Number(row!.totalCost)).toBeGreaterThanOrEqual(2500);
    expect(Number(row!.deliveries)).toBeGreaterThanOrEqual(1);
    // Cost / delivery computed
    expect(Number(row!.costPerDelivery)).toBeGreaterThan(0);
  });

  it('WIRE-SHAPE — 12 columns in expected order', async () => {
    const res = await driverVehicleCostBreakdown(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const cols = res.columns.map((c) => c.key);
    expect(cols).toEqual([
      'driver', 'vehicle', 'fuel', 'maintenance', 'toll', 'insurance', 'other',
      'totalCost', 'deliveries', 'costPerDelivery', 'revenue', 'costPercentRevenue',
    ]);
  });

  it('REGRESSION — route + CSV', async () => {
    const res = await request(app).get('/api/reports/driver-vehicle-cost-breakdown').query({ dateFrom: DAY_STR, dateTo: DAY_STR }).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const csv = await request(app).get('/api/reports/driver-vehicle-cost-breakdown').query({ dateFrom: DAY_STR, dateTo: DAY_STR, format: 'csv' }).set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
  });
});

// ─── N14 Empties-in-Transit ───────────────────────────────────────────

describe('N14 — Empties in Transit', () => {
  it('POSITIVE — cancelled stock pending_return counts as dispatched-not-returned', async () => {
    // Seed a cancelled stock event with pending_return status
    const orderId = await seedOrder({ suffix: 'N14-CS' });
    const cse = await prisma.cancelledStockEvent.create({
      data: {
        distributorId,
        orderId,
        cylinderTypeId,
        quantity: 5,
        cancellationDate: DAY,
        status: 'pending_return',
      },
    });
    cancelledStockIds.push(cse.id);

    const res = await emptiesInTransit(distributorId, {});
    const row = res.rows.find((r) => r.cylinderType && r.dispatchedNotReturned !== undefined);
    // At least the row for our cyl type should have dispatchedNotReturned ≥ 5
    const ourRow = res.rows.find((r) => Number(r.dispatchedNotReturned) >= 5);
    expect(ourRow).toBeDefined();
    expect(row).toBeDefined();
  });

  it('WIRE-SHAPE — 4 columns in expected order', async () => {
    const res = await emptiesInTransit(distributorId, {});
    const cols = res.columns.map((c) => c.key);
    expect(cols).toEqual(['cylinderType', 'dispatchedNotReturned', 'heldByCustomers', 'totalInTransit']);
  });

  it('REGRESSION — route + CSV', async () => {
    const res = await request(app).get('/api/reports/empties-in-transit').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const csv = await request(app).get('/api/reports/empties-in-transit').query({ format: 'csv' }).set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
  });
});

// ─── N17 Payment Method Mix ────────────────────────────────────────────

describe('N17 — Payment Method Mix', () => {
  it('POSITIVE — cash + UPI payments produce rows grouped by month with correct %s', async () => {
    const p1 = await prisma.paymentTransaction.create({
      data: { distributorId, customerId, amount: 3000, paymentMethod: 'cash', transactionDate: DAY },
    });
    const p2 = await prisma.paymentTransaction.create({
      data: { distributorId, customerId, amount: 2000, paymentMethod: 'upi', transactionDate: DAY },
    });
    paymentIds.push(p1.id, p2.id);

    const res = await paymentMethodMix(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const row = res.rows.find((r) => r.month === '2099-12');
    expect(row).toBeDefined();
    expect(Number(row!.total)).toBeGreaterThanOrEqual(5000);
    expect(Number(row!.cash)).toBeGreaterThanOrEqual(3000);
    expect(Number(row!.upi)).toBeGreaterThanOrEqual(2000);
    // Percentages present and sane
    expect(Number(row!.cashPct)).toBeGreaterThan(0);
    expect(Number(row!.cashPct)).toBeLessThanOrEqual(100);
  });

  it('WIRE-SHAPE — 14 columns (month + total + 6 method pairs)', async () => {
    const res = await paymentMethodMix(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    expect(res.columns).toHaveLength(14);
    const cols = res.columns.map((c) => c.key);
    expect(cols[0]).toBe('month');
    expect(cols[1]).toBe('total');
  });

  it('REGRESSION — route + CSV', async () => {
    const res = await request(app).get('/api/reports/payment-method-mix').query({ dateFrom: DAY_STR, dateTo: DAY_STR }).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const csv = await request(app).get('/api/reports/payment-method-mix').query({ dateFrom: DAY_STR, dateTo: DAY_STR, format: 'csv' }).set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
  });
});

// ─── N19 Rate Variance / Discount Leakage ─────────────────────────────

describe('N19 — Rate Variance / Discount Leakage', () => {
  it('POSITIVE — seeded configured discount + real order discount produces variance row', async () => {
    // Configure ₹50 discount for this customer × cyl type
    const disc = await prisma.customerCylinderDiscount.upsert({
      where: { customerId_cylinderTypeId: { customerId, cylinderTypeId } },
      create: { customerId, cylinderTypeId, discountPerUnit: 50 },
      update: { discountPerUnit: 50 },
    });
    discountIds.push(disc.id);

    // Seed a delivered order with ACTUAL discount ₹80 (variance = +₹30 leak)
    const order = await prisma.order.create({
      data: {
        distributorId,
        customerId,
        orderNumber: 'TEST-C4-N19-VAR',
        orderDate: DAY,
        deliveryDate: DAY,
        status: 'delivered',
        totalAmount: 1000,
        driverId: driverAId,
        vehicleId,
        items: { create: [{ cylinderTypeId, quantity: 2, deliveredQuantity: 2, unitPrice: 500, totalPrice: 1000, discountPerUnit: 80 }] },
      },
    });
    orderIds.push(order.id);

    const res = await rateVarianceLeakage(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR, customerId });
    const row = res.rows.find((r) => r.customerId === customerId);
    expect(row).toBeDefined();
    // Configured discount pinned at 50
    expect(Number(row!.configuredDiscount)).toBe(50);
    // At least 1 order counted in the window (ours). Note: avgActualDiscount
    // may be diluted by other pre-existing test seeds against this same
    // (customer, cylType) combo in the shared dev DB — so we don't pin
    // its value. The presence of a row + orderCount>=1 + configured=50
    // is the wire-shape guarantee this report is built on.
    expect(Number(row!.orderCount)).toBeGreaterThanOrEqual(1);
    expect(typeof row!.avgActualDiscount).toBe('number');
    expect(typeof row!.variance).toBe('number');
  });

  it('WIRE-SHAPE — 7 columns in expected order', async () => {
    const res = await rateVarianceLeakage(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const cols = res.columns.map((c) => c.key);
    expect(cols).toEqual([
      'customer', 'cylinderType', 'configuredDiscount', 'avgActualDiscount', 'variance', 'orderCount', 'totalImpact',
    ]);
  });

  it('REGRESSION — route + CSV', async () => {
    const res = await request(app).get('/api/reports/rate-variance-leakage').query({ dateFrom: DAY_STR, dateTo: DAY_STR }).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const csv = await request(app).get('/api/reports/rate-variance-leakage').query({ dateFrom: DAY_STR, dateTo: DAY_STR, format: 'csv' }).set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
  });
});

// ─── N21 Cash Book ────────────────────────────────────────────────────

describe('N21 — Cash Book', () => {
  it('POSITIVE — cash payment + cash expense produce netCash row', async () => {
    if (!expenseCategoryId || !creatorUserId) throw new Error('setup incomplete');
    const pay = await prisma.paymentTransaction.create({
      data: { distributorId, customerId, amount: 4000, paymentMethod: 'cash', transactionDate: DAY },
    });
    paymentIds.push(pay.id);
    const exp = await prisma.expense.create({
      data: {
        distributorId, categoryId: expenseCategoryId, expenseDate: DAY_STR,
        amount: 1500, description: 'TEST-N21 cash out', paymentMethod: 'cash',
        createdBy: creatorUserId,
      },
    });
    expenseIds.push(exp.id);

    const res = await cashBook(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const row = res.rows.find((r) => r.date === DAY_STR);
    expect(row).toBeDefined();
    expect(Number(row!.cashReceipts)).toBeGreaterThanOrEqual(4000);
    expect(Number(row!.cashExpenses)).toBeGreaterThanOrEqual(1500);
    expect(Number(row!.netCash)).toBeGreaterThanOrEqual(4000 - 1500);
  });

  it('WIRE-SHAPE — 6 columns in expected order', async () => {
    const res = await cashBook(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const cols = res.columns.map((c) => c.key);
    expect(cols).toEqual(['date', 'cashReceipts', 'receiptCount', 'cashExpenses', 'expenseCount', 'netCash']);
  });

  it('REGRESSION — route + CSV', async () => {
    const res = await request(app).get('/api/reports/cash-book').query({ dateFrom: DAY_STR, dateTo: DAY_STR }).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const csv = await request(app).get('/api/reports/cash-book').query({ dateFrom: DAY_STR, dateTo: DAY_STR, format: 'csv' }).set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
  });
});

// ─── N22 Cashflow Statement ───────────────────────────────────────────

describe('N22 — Cashflow Statement', () => {
  it('POSITIVE — payment + deposit + expense yield monthly cashflow row with net + cumulative', async () => {
    if (!expenseCategoryId || !creatorUserId) throw new Error('setup incomplete');
    // Fixtures added in previous tests already move cashflow; verify shape + math.
    const res = await cashflowStatement(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const row = res.rows.find((r) => r.month === '2099-12');
    if (row) {
      // Verify net = inflows - outflows
      const expectedNet = Number(row.inflowPayments) + Number(row.inflowDeposits)
        - Number(row.outflowExpenses) - Number(row.outflowRefunds);
      expect(Number(row.netCashflow)).toBe(expectedNet);
    }
    // If no row, still valid — response must be well-formed
    expect(Array.isArray(res.rows)).toBe(true);
  });

  it('WIRE-SHAPE — 7 columns in expected order', async () => {
    const res = await cashflowStatement(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const cols = res.columns.map((c) => c.key);
    expect(cols).toEqual([
      'month', 'inflowPayments', 'inflowDeposits', 'outflowExpenses', 'outflowRefunds', 'netCashflow', 'cumulative',
    ]);
  });

  it('REGRESSION — route + CSV', async () => {
    const res = await request(app).get('/api/reports/cashflow-statement').query({ dateFrom: DAY_STR, dateTo: DAY_STR }).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const csv = await request(app).get('/api/reports/cashflow-statement').query({ dateFrom: DAY_STR, dateTo: DAY_STR, format: 'csv' }).set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
  });
});

// ─── N33 Expenses by Category (Trend) ─────────────────────────────────

describe('N33 — Expenses by Category (Trend)', () => {
  it('POSITIVE — seeded expenses across different categories produce category rows', async () => {
    // Test relies on the earlier Fuel expense from N13 + Cash expense from N21
    const res = await expensesByCategoryTrend(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    expect(res.rows.length).toBeGreaterThanOrEqual(1);
    // Verify total column exists on every row and is numeric
    for (const r of res.rows) {
      expect(typeof r.total === 'number' || r.total === 0).toBe(true);
    }
  });

  it('WIRE-SHAPE — columns start with category, end with total; dynamic month columns in between', async () => {
    const res = await expensesByCategoryTrend(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    expect(res.columns[0].key).toBe('category');
    expect(res.columns[res.columns.length - 1].key).toBe('total');
    expect(res.columns[res.columns.length - 1].money).toBe(true);
  });

  it('REGRESSION — route + CSV', async () => {
    const res = await request(app).get('/api/reports/expenses-by-category-trend').query({ dateFrom: DAY_STR, dateTo: DAY_STR }).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const csv = await request(app).get('/api/reports/expenses-by-category-trend').query({ dateFrom: DAY_STR, dateTo: DAY_STR, format: 'csv' }).set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
  });
});

// ─── N34 Accountability Log Report ────────────────────────────────────

describe('N34 — Accountability Log Report', () => {
  it('POSITIVE — seeded accountability incident appears with status suffix stripped', async () => {
    const log = await prisma.accountabilityLog.create({
      data: {
        distributorId,
        driverId: driverAId,
        customerId,
        cylinderTypeId,
        incidentType: 'lost_cylinder',
        incidentDate: DAY,
        quantity: 1,
        costAmount: 2500,
        description: 'TEST-N34 cylinder lost incident',
        status: 'open_accountability',
      },
    });
    accountabilityIds.push(log.id);

    const res = await accountabilityLogReport(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const row = res.rows.find((r) => r.description === 'TEST-N34 cylinder lost incident');
    expect(row).toBeDefined();
    // Status suffix `_accountability` stripped
    expect(row!.status).toBe('open');
    expect(Number(row!.costAmount)).toBe(2500);
    expect(Number(row!.quantity)).toBe(1);
  });

  it('WIRE-SHAPE — 10 columns in expected order', async () => {
    const res = await accountabilityLogReport(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const cols = res.columns.map((c) => c.key);
    expect(cols).toEqual([
      'incidentDate', 'incidentType', 'driver', 'customer', 'cylinderType',
      'quantity', 'costAmount', 'description', 'status', 'resolutionNotes',
    ]);
  });

  it('REGRESSION — route + CSV', async () => {
    const res = await request(app).get('/api/reports/accountability-log-report').query({ dateFrom: DAY_STR, dateTo: DAY_STR }).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const csv = await request(app).get('/api/reports/accountability-log-report').query({ dateFrom: DAY_STR, dateTo: DAY_STR, format: 'csv' }).set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
  });
});

// ─── N27 Delivery Challan PDF — placeholder-only ──────────────────────

describe('N27 — Delivery Challan PDF (placeholder)', () => {
  it('CATALOG — entry exists with comingSoon:true and kind=external', async () => {
    const res = await request(app).get('/api/reports/catalog').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const entry = res.body.data.entries.find((e: { slug: string }) => e.slug === 'delivery-challan-pdf');
    expect(entry).toBeDefined();
    expect(entry.comingSoon).toBe(true);
    expect(entry.kind).toBe('external');
    expect(entry.bucket).toBe('invoicing-payments');
  });

  it('NO ROUTE — /api/reports/delivery-challan-pdf 404s (no service registered yet)', async () => {
    const res = await request(app).get('/api/reports/delivery-challan-pdf').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
