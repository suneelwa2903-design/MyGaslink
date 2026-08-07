/**
 * Tests — N18 Customer Profitability (2026-08-06)
 *
 * The service computes per-customer:
 *   Revenue        = Σ delivered-order totalAmount over the window
 *   Avg Outstanding = (openingLedgerBalance + closingLedgerBalance) / 2
 *   AR Cost        = Avg Outstanding × (rate/100) × (days/365)
 *   Empty Value    = Σ withCustomerQty × EmptyCylinderPrice
 *   Empty Cost     = Empty Value × rateFactor
 *   Adjusted Rev   = Revenue − AR Cost − Empty Cost
 *   Margin %       = Adjusted Rev / Revenue × 100
 *   DSO            = Avg Outstanding / (Revenue / days)
 *
 * Coverage:
 *   POSITIVE — high-outstanding customer at 12% shows the expected AR cost.
 *   POSITIVE — rate override actually changes AR cost (linear scaling).
 *   POSITIVE — customer with empties held generates non-zero empty cost.
 *   POSITIVE — worst-adjusted-revenue customer sorts to the top.
 *   NEGATIVE — customer with zero revenue over the window is NOT included.
 *   NEGATIVE — rate=0 → AR cost is 0 (no interest applied).
 *   WIRE-SHAPE — 10 columns in canonical order.
 *   REGRESSION — /api/reports/customer-profitability reachable + CSV export.
 *   ROLE — inventory role CAN see this (all-staff, unlike GST reports).
 *   PARAM — arInterestRatePct clamped to [0, 50] at service boundary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsInventory } from './helpers.js';
import { customerProfitability } from '../services/reportsService.js';
import { randomUUID } from 'crypto';
import type { Express } from 'express';

const distributorId = 'dist-001';
// Anti-pattern #7 — far-future window so real seed data doesn't contaminate.
const DAY_FROM = '2099-10-01';
const DAY_TO = '2099-10-31';
// Matches the service's inclusive-day count:
//   range() → to = DAY_TO at 23:59:59.999Z (see reportsService.ts:130).
//   daysMs / 86.4M ≈ 30.9999, Math.round → 31, then +1 (inclusive) → 32.
const DAYS = 32;

let app: Express;
let adminToken: string;
let inventoryToken: string;
let cylinderTypeId: string;
let _originalEmptyPrice: number | null = null;
let seededEmptyPriceId: string | null = null;
const trackedCustomerIds: string[] = [];
const trackedOrderIds: string[] = [];
const trackedLedgerIds: string[] = [];

async function seedCustomer(name: string, revenue: number, opts: {
  ledgerOpening?: number; // ledger sum strictly before DAY_FROM
  ledgerClosing?: number; // ledger sum up to DAY_TO (inclusive of opening)
  emptiesHeld?: number;
}): Promise<string> {
  const cust = await prisma.customer.create({
    data: {
      distributorId,
      customerName: `N18-${name}-${Date.now()}`,
      phone: `9847${Math.floor(Math.random() * 900000 + 100000)}`,
      customerType: 'B2B',
      billingAddressLine1: 'N18 Test',
      billingCity: 'Bangalore',
      billingState: 'Karnataka',
      creditPeriodDays: 30,
    },
  });
  trackedCustomerIds.push(cust.id);

  if (revenue > 0) {
    // Single delivered order = full revenue for the window.
    const orderId = randomUUID();
    await prisma.order.create({
      data: {
        id: orderId,
        distributorId,
        customerId: cust.id,
        orderNumber: `N18-ORD-${name}-${Date.now()}`,
        orderDate: new Date(DAY_FROM),
        deliveryDate: new Date(DAY_FROM),
        deliveredAt: new Date(DAY_FROM),
        status: 'delivered',
        totalAmount: revenue,
        items: {
          create: [{
            cylinderTypeId,
            quantity: 1,
            deliveredQuantity: 1,
            emptiesCollected: 0,
            unitPrice: revenue,
            totalPrice: revenue,
          }],
        },
      },
    });
    trackedOrderIds.push(orderId);
  }

  if (opts.ledgerOpening !== undefined && opts.ledgerOpening !== 0) {
    // Entry BEFORE DAY_FROM → contributes to opening balance.
    const beforeStart = new Date(DAY_FROM);
    beforeStart.setDate(beforeStart.getDate() - 30);
    const openingEntry = await prisma.customerLedgerEntry.create({
      data: {
        distributorId,
        customerId: cust.id,
        entryDate: beforeStart,
        entryType: 'invoice_entry',
        referenceId: `N18-OPEN-${cust.id}`,
        amountDelta: opts.ledgerOpening,
        narration: 'N18 opening seed',
      },
    });
    trackedLedgerIds.push(openingEntry.id);
  }

  // ledgerClosing is interpreted as the ABSOLUTE closing balance; delta from
  // opening = closing − opening. Seed this delta as one in-window entry so
  // the service's opening(<from) vs closing(<=to) groupBy sees the right totals.
  const openingAmount = opts.ledgerOpening ?? 0;
  const closingAdditionalDelta = (opts.ledgerClosing ?? openingAmount) - openingAmount;
  if (closingAdditionalDelta !== 0) {
    // Entry inside [DAY_FROM, DAY_TO] window → contributes to closing but NOT opening.
    const inWindow = new Date(DAY_FROM);
    inWindow.setDate(inWindow.getDate() + 5);
    const closingEntry = await prisma.customerLedgerEntry.create({
      data: {
        distributorId,
        customerId: cust.id,
        entryDate: inWindow,
        entryType: closingAdditionalDelta > 0 ? 'invoice_entry' : 'payment_entry',
        referenceId: `N18-CLOSE-${cust.id}`,
        amountDelta: closingAdditionalDelta,
        narration: 'N18 closing seed',
      },
    });
    trackedLedgerIds.push(closingEntry.id);
  }

  if (opts.emptiesHeld && opts.emptiesHeld > 0) {
    await prisma.customerInventoryBalance.upsert({
      where: { customerId_cylinderTypeId: { customerId: cust.id, cylinderTypeId } },
      create: {
        customerId: cust.id,
        cylinderTypeId,
        withCustomerQty: opts.emptiesHeld,
        pendingReturns: 0,
      },
      update: { withCustomerQty: opts.emptiesHeld },
    });
  }

  return cust.id;
}

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  inventoryToken = (await loginAsInventory()).token;
  const cyl = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId, isActive: true },
    select: { id: true },
  });
  cylinderTypeId = cyl.id;

  // Ensure an EmptyCylinderPrice exists for this cyl type so empties value
  // is deterministic. Snapshot the current latest for cleanup.
  const existing = await prisma.emptyCylinderPrice.findFirst({
    where: { distributorId, cylinderTypeId },
    orderBy: { effectiveDate: 'desc' },
    select: { id: true, emptyCylinderPrice: true },
  });
  _originalEmptyPrice = existing ? Number(existing.emptyCylinderPrice) : null;
  // Seed a NEW price row with effectiveDate INSIDE the far-future window so
  // it wins the "latest" pick without disturbing real ledger. Uses ₹1000
  // per cyl for round-number assertions.
  const seeded = await prisma.emptyCylinderPrice.create({
    data: {
      distributorId,
      cylinderTypeId,
      emptyCylinderPrice: 1000,
      effectiveDate: new Date('2099-09-01'),
    },
  });
  seededEmptyPriceId = seeded.id;
});

afterAll(async () => {
  if (trackedLedgerIds.length) {
    await prisma.customerLedgerEntry.deleteMany({ where: { id: { in: trackedLedgerIds } } });
  }
  if (trackedOrderIds.length) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: trackedOrderIds } } });
  }
  if (trackedCustomerIds.length) {
    await prisma.customerInventoryBalance.deleteMany({
      where: { customerId: { in: trackedCustomerIds } },
    });
    await prisma.customer.deleteMany({ where: { id: { in: trackedCustomerIds } } });
  }
  if (seededEmptyPriceId) {
    await prisma.emptyCylinderPrice.delete({ where: { id: seededEmptyPriceId } }).catch(() => {});
  }
});

describe('N18 — Customer Profitability', () => {
  it('POSITIVE — high-outstanding customer produces expected AR cost at 12%', async () => {
    // Revenue 100000; ledger opening 100000, closing 100000 → avgOut = 100000.
    // Rate = 12%/yr, days = 31 → rateFactor = 0.12 * 31/365 ≈ 0.010192.
    // AR cost ≈ 100000 * 0.010192 ≈ 1019.
    const custId = await seedCustomer('HIGH-AR', 100_000, {
      ledgerOpening: 100_000,
      ledgerClosing: 100_000,
    });
    const res = await customerProfitability(distributorId, {
      dateFrom: DAY_FROM,
      dateTo: DAY_TO,
      customerId: custId,
      arInterestRatePct: 12,
    });
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(row.revenue).toBe(100_000);
    expect(row.avgOutstanding).toBe(100_000);
    // Loose ±5 range to absorb rounding + calendar-day boundary rounding.
    const expectedArCost = Math.round(100_000 * 0.12 * (DAYS / 365));
    expect(Math.abs(Number(row.arCost) - expectedArCost)).toBeLessThanOrEqual(5);
  });

  it('POSITIVE — rate override scales AR cost linearly (24% is 2× of 12%)', async () => {
    const custId = await seedCustomer('RATE-SCALING', 60_000, {
      ledgerOpening: 60_000,
      ledgerClosing: 60_000,
    });
    const at12 = await customerProfitability(distributorId, {
      dateFrom: DAY_FROM, dateTo: DAY_TO, customerId: custId, arInterestRatePct: 12,
    });
    const at24 = await customerProfitability(distributorId, {
      dateFrom: DAY_FROM, dateTo: DAY_TO, customerId: custId, arInterestRatePct: 24,
    });
    const c12 = Number(at12.rows[0].arCost);
    const c24 = Number(at24.rows[0].arCost);
    // 24 / 12 = 2× ± rounding slop.
    expect(c24 / c12).toBeGreaterThan(1.95);
    expect(c24 / c12).toBeLessThan(2.05);
  });

  it('POSITIVE — customer holding empties generates non-zero Empty Cost', async () => {
    // 5 empties × ₹1000 = ₹5000 empty value. At 12% × 31/365 → ~₹51 empty cost.
    const custId = await seedCustomer('EMPTIES', 20_000, {
      ledgerOpening: 0, ledgerClosing: 0, emptiesHeld: 5,
    });
    const res = await customerProfitability(distributorId, {
      dateFrom: DAY_FROM, dateTo: DAY_TO, customerId: custId, arInterestRatePct: 12,
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].emptiesValue).toBe(5000);
    expect(Number(res.rows[0].emptyCost)).toBeGreaterThan(0);
    // AR cost should be 0 (no outstanding), empty cost > 0.
    expect(res.rows[0].arCost).toBe(0);
  });

  it('POSITIVE — worst-adjusted-revenue customer sorts to the top', async () => {
    // Cust A — clean: revenue 50000, no outstanding → adjusted ~= revenue.
    const cleanId = await seedCustomer('SORT-CLEAN', 50_000, {
      ledgerOpening: 0, ledgerClosing: 0,
    });
    // Cust B — bad: revenue 50000 but huge outstanding → adjusted << revenue.
    const badId = await seedCustomer('SORT-BAD', 50_000, {
      ledgerOpening: 500_000, ledgerClosing: 500_000,
    });
    const res = await customerProfitability(distributorId, {
      dateFrom: DAY_FROM, dateTo: DAY_TO, arInterestRatePct: 24,
    });
    // Find their positions among the filtered rows.
    const idxClean = res.rows.findIndex((r) => r.customerId === cleanId);
    const idxBad = res.rows.findIndex((r) => r.customerId === badId);
    expect(idxClean).toBeGreaterThanOrEqual(0);
    expect(idxBad).toBeGreaterThanOrEqual(0);
    // Bad customer's adjusted revenue lower → appears BEFORE clean in sort order.
    expect(idxBad).toBeLessThan(idxClean);
  });

  it('NEGATIVE — customer with zero revenue in window is NOT in the result', async () => {
    // Seed a customer with a ledger balance but no delivered orders.
    const custId = await seedCustomer('NO-REV', 0, {
      ledgerOpening: 10_000, ledgerClosing: 10_000,
    });
    const res = await customerProfitability(distributorId, {
      dateFrom: DAY_FROM, dateTo: DAY_TO,
    });
    expect(res.rows.find((r) => r.customerId === custId)).toBeUndefined();
  });

  it('NEGATIVE — rate=0 zeroes both AR cost AND Empty cost', async () => {
    const custId = await seedCustomer('RATE-ZERO', 40_000, {
      ledgerOpening: 40_000, ledgerClosing: 40_000, emptiesHeld: 3,
    });
    const res = await customerProfitability(distributorId, {
      dateFrom: DAY_FROM, dateTo: DAY_TO, customerId: custId, arInterestRatePct: 0,
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].arCost).toBe(0);
    expect(res.rows[0].emptyCost).toBe(0);
    // At rate=0, adjusted revenue equals gross revenue.
    expect(res.rows[0].adjustedRevenue).toBe(40_000);
    expect(res.rows[0].marginPct).toBe(100);
  });

  it('PARAM — arInterestRatePct clamped at 50 (over-max input treated as 50)', async () => {
    const custId = await seedCustomer('CLAMP-MAX', 30_000, {
      ledgerOpening: 30_000, ledgerClosing: 30_000,
    });
    const at50 = await customerProfitability(distributorId, {
      dateFrom: DAY_FROM, dateTo: DAY_TO, customerId: custId, arInterestRatePct: 50,
    });
    const at999 = await customerProfitability(distributorId, {
      dateFrom: DAY_FROM, dateTo: DAY_TO, customerId: custId, arInterestRatePct: 999,
    });
    expect(at50.rows[0].arCost).toBe(at999.rows[0].arCost);
  });

  it('WIRE-SHAPE — 10 columns in expected canonical order', async () => {
    const res = await customerProfitability(distributorId, { dateFrom: DAY_FROM, dateTo: DAY_TO });
    const cols = res.columns.map((c) => c.key);
    expect(cols).toEqual([
      'customer',
      'orders',
      'revenue',
      'avgOutstanding',
      'dso',
      'emptiesValue',
      'arCost',
      'emptyCost',
      'adjustedRevenue',
      'marginPct',
    ]);
  });

  it('REGRESSION — /api/reports/customer-profitability reachable via HTTP + wire shape holds', async () => {
    const res = await request(app)
      .get('/api/reports/customer-profitability')
      .query({ dateFrom: DAY_FROM, dateTo: DAY_TO, arInterestRatePct: 15 })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('columns');
    expect(res.body.data).toHaveProperty('rows');
    expect(res.body.data).toHaveProperty('totals');
  });

  it('REGRESSION — CSV export produces valid CSV headers matching column labels', async () => {
    const res = await request(app)
      .get('/api/reports/customer-profitability')
      .query({ dateFrom: DAY_FROM, dateTo: DAY_TO, arInterestRatePct: 12, format: 'csv' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.split('\n')[0]).toContain('Customer');
    expect(res.text.split('\n')[0]).toContain('Adjusted Revenue');
    expect(res.text.split('\n')[0]).toContain('Margin');
  });

  it('ROLE — inventory role sees customer-profitability in catalog (all-staff, unlike GST reports)', async () => {
    const res = await request(app)
      .get('/api/reports/catalog')
      .set('Authorization', `Bearer ${inventoryToken}`);
    expect(res.status).toBe(200);
    const slugs = res.body.data.entries.map((e: { slug: string }) => e.slug);
    expect(slugs).toContain('customer-profitability');
  });
});
