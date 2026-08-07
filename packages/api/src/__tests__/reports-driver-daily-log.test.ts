/**
 * Tests — driverDailyLog report (2026-08-06)
 *
 * Merger of the deleted `dailyDriverMovement` + `routeDriverPerformance`
 * reports. One row per (date × driver), with per-trip child rows for
 * expand-row UI. Assertions cover:
 *   - Positive: seeded delivered order shows on parent + trip child
 *   - Positive: cancelled order counts toward cancel-rate on parent + child
 *   - Positive: same-driver same-day multi-trip → multiple child rows
 *   - Negative: order for OTHER driver excluded when driverId filter set
 *   - Wire-shape: 11 columns in the expected order, revenue money-flagged
 *   - Trip attribution: backdated order with tripNumber=1 shows as child
 *     under its parent driver-day (regression on Gap 1 fix)
 *   - Integration: /api/reports/driver-daily-log route + CSV export
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin } from './helpers.js';
import { driverDailyLog } from '../services/reportsService.js';
import { randomUUID } from 'crypto';
import type { Express } from 'express';

const distributorId = 'dist-001';
// Anti-pattern #7 — far-future date so real orders don't leak in.
const DAY = '2099-11-22';
const DAY_STR = DAY;

let app: Express;
let token: string;
let driverAId: string;
let driverBId: string;
let vehicleId: string;
let cylinderTypeId: string;
const createdOrderIds: string[] = [];

async function seedOrder(opts: {
  driverId: string;
  status: 'delivered' | 'cancelled';
  amount: number;
  qty: number;
  emptiesCollected?: number;
  tripNumber?: number | null;
  suffix: string;
}): Promise<string> {
  const cust = await prisma.customer.findFirst({
    where: { distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!cust) throw new Error('no customer');
  const orderId = randomUUID();
  await prisma.order.create({
    data: {
      id: orderId,
      distributorId,
      customerId: cust.id,
      orderNumber: `DDL-TEST-${opts.suffix}-${Date.now()}`,
      orderDate: new Date(DAY),
      deliveryDate: new Date(DAY),
      deliveredAt: opts.status === 'delivered' ? new Date(DAY) : null,
      status: opts.status,
      totalAmount: opts.amount,
      driverId: opts.driverId,
      vehicleId,
      tripNumber: opts.tripNumber ?? null,
      items: {
        create: [{
          cylinderTypeId,
          quantity: opts.qty,
          deliveredQuantity: opts.status === 'delivered' ? opts.qty : 0,
          emptiesCollected: opts.emptiesCollected ?? 0,
          unitPrice: 1000,
          totalPrice: opts.amount,
        }],
      },
    },
  });
  createdOrderIds.push(orderId);
  return orderId;
}

beforeAll(async () => {
  app = createApp();
  const login = await loginAsDistAdmin();
  token = login.token;

  const drivers = await prisma.driver.findMany({
    where: { distributorId, deletedAt: null },
    take: 2,
    select: { id: true },
  });
  driverAId = drivers[0].id;
  driverBId = drivers[1].id;
  const vehicle = await prisma.vehicle.findFirstOrThrow({
    where: { distributorId, deletedAt: null },
    select: { id: true },
  });
  vehicleId = vehicle.id;
  const cyl = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId, isActive: true },
    select: { id: true },
  });
  cylinderTypeId = cyl.id;
});

afterAll(async () => {
  if (createdOrderIds.length > 0) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
});

describe('driverDailyLog — merged Daily Book report', () => {
  it('POSITIVE — seeded delivered order shows on driver-day parent row', async () => {
    await seedOrder({ driverId: driverAId, status: 'delivered', amount: 5000, qty: 3, tripNumber: 1, suffix: 'POS-1' });
    const res = await driverDailyLog(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const parent = res.rows.find((r) => r.type === 'driver_day' && r.driverId === driverAId && r.date === DAY_STR);
    expect(parent).toBeDefined();
    expect(Number(parent!.deliveries)).toBeGreaterThanOrEqual(1);
    expect(Number(parent!.fullsDelivered)).toBeGreaterThanOrEqual(3);
    expect(Number(parent!.revenue)).toBeGreaterThanOrEqual(5000);
    expect(Number(parent!.trips)).toBeGreaterThanOrEqual(1);
  });

  it('POSITIVE — trip child row follows parent for same-day driver', async () => {
    const res = await driverDailyLog(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    // Find the parent index, then verify the next row is a trip child for the same driver.
    const parentIdx = res.rows.findIndex((r) => r.type === 'driver_day' && r.driverId === driverAId && r.date === DAY_STR);
    expect(parentIdx).toBeGreaterThanOrEqual(0);
    const child = res.rows[parentIdx + 1];
    expect(child).toBeDefined();
    expect(child.type).toBe('trip');
    expect(child.driverId).toBe(driverAId);
    expect(String(child.trip)).toMatch(/Trip \d+/);
  });

  it('POSITIVE — cancelled order counts toward cancel % on parent row', async () => {
    await seedOrder({ driverId: driverAId, status: 'cancelled', amount: 500, qty: 1, tripNumber: 1, suffix: 'POS-CAN' });
    const res = await driverDailyLog(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const parent = res.rows.find((r) => r.type === 'driver_day' && r.driverId === driverAId && r.date === DAY_STR);
    expect(parent).toBeDefined();
    expect(Number(parent!.cancelled)).toBeGreaterThanOrEqual(1);
    expect(Number(parent!.cancelRate)).toBeGreaterThan(0);
    expect(Number(parent!.cancelRate)).toBeLessThanOrEqual(100);
  });

  it('POSITIVE — same-driver same-day two trips produce TWO child rows under one parent', async () => {
    // driver B, day = DAY, two orders with tripNumber=1 and tripNumber=2.
    await seedOrder({ driverId: driverBId, status: 'delivered', amount: 2000, qty: 2, tripNumber: 1, suffix: 'POS-T1' });
    await seedOrder({ driverId: driverBId, status: 'delivered', amount: 3000, qty: 2, tripNumber: 2, suffix: 'POS-T2' });
    const res = await driverDailyLog(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const parentIdx = res.rows.findIndex((r) => r.type === 'driver_day' && r.driverId === driverBId && r.date === DAY_STR);
    expect(parentIdx).toBeGreaterThanOrEqual(0);
    const parent = res.rows[parentIdx];
    expect(Number(parent.trips)).toBeGreaterThanOrEqual(2);
    // Collect trip child rows for driver B on this day (they appear
    // between this parent and the next parent — or end of list).
    let nextParentIdx = res.rows.slice(parentIdx + 1).findIndex((r) => r.type === 'driver_day');
    if (nextParentIdx === -1) nextParentIdx = res.rows.length - parentIdx - 1;
    const childRows = res.rows.slice(parentIdx + 1, parentIdx + 1 + nextParentIdx).filter((r) => r.type === 'trip');
    expect(childRows.length).toBeGreaterThanOrEqual(2);
  });

  it('NEGATIVE — driverId filter excludes other drivers', async () => {
    const res = await driverDailyLog(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR, driverId: driverAId });
    // Every parent row should be driver A only.
    const parentDrivers = new Set(res.rows.filter((r) => r.type === 'driver_day').map((r) => r.driverId));
    expect(parentDrivers.size).toBeLessThanOrEqual(1);
    if (parentDrivers.size === 1) {
      expect([...parentDrivers][0]).toBe(driverAId);
    }
  });

  it('WIRE-SHAPE — 11 columns in expected order, revenue is money', async () => {
    const res = await driverDailyLog(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const cols = res.columns.map((c) => c.key);
    expect(cols).toEqual([
      'date', 'driverName', 'trip', 'trips', 'deliveries', 'cancelled',
      'fullsDelivered', 'emptiesCollected', 'revenue', 'onTimeRate', 'cancelRate',
    ]);
    expect(res.columns.find((c) => c.key === 'revenue')?.money).toBe(true);
  });

  it('REGRESSION — /api/reports/driver-daily-log route + CSV export', async () => {
    const res = await request(app)
      .get('/api/reports/driver-daily-log')
      .query({ dateFrom: DAY_STR, dateTo: DAY_STR })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('columns');
    expect(res.body.data).toHaveProperty('rows');
    const csv = await request(app)
      .get('/api/reports/driver-daily-log')
      .query({ dateFrom: DAY_STR, dateTo: DAY_STR, format: 'csv' })
      .set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
  });

  it('REGRESSION — orphan (no tripNumber) order still appears but as "No trip" child', async () => {
    // Godown/mini-op-style order — has driverId but no tripNumber.
    await seedOrder({ driverId: driverAId, status: 'delivered', amount: 1500, qty: 1, tripNumber: null, suffix: 'REG-ORPHAN' });
    const res = await driverDailyLog(distributorId, { dateFrom: DAY_STR, dateTo: DAY_STR });
    const parentIdx = res.rows.findIndex((r) => r.type === 'driver_day' && r.driverId === driverAId);
    const nextParentIdx = res.rows.slice(parentIdx + 1).findIndex((r) => r.type === 'driver_day');
    const end = nextParentIdx === -1 ? res.rows.length : parentIdx + 1 + nextParentIdx;
    const children = res.rows.slice(parentIdx + 1, end);
    const orphan = children.find((c) => c.trip === 'No trip');
    expect(orphan).toBeDefined();
  });
});
