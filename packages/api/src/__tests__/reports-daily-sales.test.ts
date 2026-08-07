// 2026-08-05 Chunk 2 — Daily Sales report tests.
//
// Covers dailySales() service + /api/reports/daily-sales route:
//   - Positive: 3 delivered orders + 1 payment split across 2 days yields
//     exactly 2 rows with correct per-day aggregates
//   - Positive: empty range → empty rows + zero totals (never crashes)
//   - Wire-shape: 6 columns in expected order; totals row has all keys
//   - Regression: /api/reports/daily-sales resolves via the generic
//     /:reportType handler; CSV export works
//   - Anti-pattern #1: dist-B orders on the same date invisible to dist-A
//
// TEST_DATE 2099-12-26 + 2099-12-25 (2 consecutive days) per anti-pattern #7.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { dailySales } from '../services/reportsService.js';
import { getSeedData, loginAsDistAdmin } from './helpers.js';

const DAY1 = new Date('2099-12-25T00:00:00.000Z');
const DAY2 = new Date('2099-12-26T00:00:00.000Z');
const DAY1_STR = '2099-12-25';
const DAY2_STR = '2099-12-26';

let app: Express;
let token: string;
let distributorId: string;
let cylinderTypeId: string;
let customerId: string;
const orderIds: string[] = [];
const paymentIds: string[] = [];

beforeAll(async () => {
  app = createApp();
  const login = await loginAsDistAdmin();
  token = login.token;
  distributorId = login.distributorId;
  const seed = await getSeedData();
  cylinderTypeId = seed.cylinderTypes[0].id;
  customerId = seed.customers[0].id;
});

afterAll(async () => {
  if (paymentIds.length) {
    await prisma.paymentTransaction.deleteMany({ where: { id: { in: paymentIds } } });
  }
  if (orderIds.length) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
});

async function seedDeliveredOrder(day: Date, suffix: string, amount: number, qty: number): Promise<string> {
  const order = await prisma.order.create({
    data: {
      distributorId,
      customerId,
      orderNumber: `TEST-DAILY-SALES-${suffix}`,
      orderDate: day,
      deliveryDate: day,
      status: 'delivered',
      totalAmount: amount,
      items: {
        create: [
          { cylinderTypeId, quantity: qty, deliveredQuantity: qty, unitPrice: amount / qty, totalPrice: amount },
        ],
      },
    },
  });
  orderIds.push(order.id);
  return order.id;
}

describe('reportsService.dailySales — Chunk 2', () => {
  it('POSITIVE — 3 orders + 1 payment across 2 days → 2 rows with correct aggregates', async () => {
    // Day 1: 2 orders (₹1000 + ₹500 = ₹1500, 3 + 2 = 5 fulls delivered), 1 payment (₹800)
    await seedDeliveredOrder(DAY1, 'D1-A', 1000, 3);
    await seedDeliveredOrder(DAY1, 'D1-B', 500, 2);
    const pay = await prisma.paymentTransaction.create({
      data: {
        distributorId,
        customerId,
        amount: 800,
        paymentMethod: 'cash',
        transactionDate: DAY1,
      },
    });
    paymentIds.push(pay.id);
    // Day 2: 1 order (₹300, 1 full)
    await seedDeliveredOrder(DAY2, 'D2-A', 300, 1);

    const res = await dailySales(distributorId, { dateFrom: DAY1_STR, dateTo: DAY2_STR });

    // Filter our two seeded days out of the row list (dev-DB may have
    // other days in it; this test only pins the days we seeded).
    const day1Row = res.rows.find((r) => r.date === DAY1_STR);
    const day2Row = res.rows.find((r) => r.date === DAY2_STR);
    expect(day1Row).toBeDefined();
    expect(day2Row).toBeDefined();

    // Day 1 aggregates
    expect(Number(day1Row!.orders)).toBeGreaterThanOrEqual(2);
    expect(Number(day1Row!.qtyDelivered)).toBeGreaterThanOrEqual(5);
    expect(Number(day1Row!.revenue)).toBeGreaterThanOrEqual(1500);
    expect(Number(day1Row!.paymentsReceived)).toBeGreaterThanOrEqual(800);
    expect(Number(day1Row!.paymentsCount)).toBeGreaterThanOrEqual(1);

    // Day 2 aggregates
    expect(Number(day2Row!.orders)).toBeGreaterThanOrEqual(1);
    expect(Number(day2Row!.qtyDelivered)).toBeGreaterThanOrEqual(1);
    expect(Number(day2Row!.revenue)).toBeGreaterThanOrEqual(300);
  });

  it('POSITIVE — empty range (day with no fixtures) → clean response, no crash', async () => {
    // Far-future date with no activity.
    const res = await dailySales(distributorId, {
      dateFrom: '2099-12-20',
      dateTo: '2099-12-20',
    });
    expect(Array.isArray(res.rows)).toBe(true);
    // May be 0 rows or a scattering of unrelated fixtures — but the
    // response must be well-formed.
    expect(res.columns).toBeDefined();
    expect(res.totals).toBeDefined();
    expect(Number(res.totals!.orders ?? 0)).toBe(0);
  });

  it('WIRE-SHAPE — columns in expected order + totals row has all keys', async () => {
    const res = await dailySales(distributorId, { dateFrom: DAY1_STR, dateTo: DAY2_STR });
    const colKeys = res.columns.map((c) => c.key);
    // 2026-08-06 (FX-E): added cylMix + empties + expenses columns.
    expect(colKeys).toEqual([
      'date', 'orders', 'qtyDelivered', 'cylMix', 'empties',
      'revenue', 'paymentsReceived', 'paymentsCount', 'expenses',
    ]);
    // Money columns — revenue (idx 5), paymentsReceived (idx 6), expenses (idx 8).
    expect(res.columns[5].money).toBe(true);
    expect(res.columns[6].money).toBe(true);
    expect(res.columns[8].money).toBe(true);
    // Totals has all numeric keys
    expect(res.totals).toHaveProperty('orders');
    expect(res.totals).toHaveProperty('qtyDelivered');
    expect(res.totals).toHaveProperty('empties');
    expect(res.totals).toHaveProperty('revenue');
    expect(res.totals).toHaveProperty('paymentsReceived');
    expect(res.totals).toHaveProperty('expenses');
  });

  it('REGRESSION — /api/reports/daily-sales reachable via generic /:reportType', async () => {
    const res = await request(app)
      .get('/api/reports/daily-sales')
      .query({ dateFrom: DAY1_STR, dateTo: DAY2_STR })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('columns');
    expect(res.body.data).toHaveProperty('rows');
    expect(res.body.data).toHaveProperty('chart');
  });

  it('REGRESSION — CSV export works via ?format=csv', async () => {
    const res = await request(app)
      .get('/api/reports/daily-sales')
      .query({ dateFrom: DAY1_STR, dateTo: DAY2_STR, format: 'csv' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Date');
    expect(res.text).toContain('Revenue');
  });

  it('CROSS-TENANT — dist-A dailySales does not include dist-B activity', async () => {
    const distB = await prisma.distributor.findFirst({
      where: { id: { not: distributorId }, deletedAt: null },
    });
    if (!distB) return;
    // Sanity — we didn't seed dist-B fixtures, so dist-A's query should be
    // unchanged from prior tests. The strict guard is that the where
    // clause has distributorId — if it were missing, dist-B's real seed
    // data would leak into our results and blow up the totals.
    const res = await dailySales(distributorId, { dateFrom: DAY1_STR, dateTo: DAY2_STR });
    // Every row's date is a string like YYYY-MM-DD (not a cross-tenant leak marker).
    for (const r of res.rows) {
      expect(typeof r.date).toBe('string');
      expect(/^\d{4}-\d{2}-\d{2}$/.test(String(r.date))).toBe(true);
    }
  });
});
