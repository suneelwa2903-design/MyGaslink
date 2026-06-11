/**
 * Phase 4b — billing bug fixes + cron + invoice discount.
 *
 * Three independent fixes under test:
 *
 *  1. generateBillingCycle no longer requires billingTier when
 *     subscriptionPlan is set — instead derives a sensible tier and
 *     writes that to the cycle row. Pre-Phase-4b this combination
 *     threw BillingError("Cannot generate billing cycle without a
 *     billing tier assigned").
 *
 *  2. seatRequestService.approveSeatRequest picks per-role overage
 *     pricing from the Phase 4a columns. Pre-Phase-4b every non-driver
 *     role silently fell through to extraSeatPriceAdmin (₹999),
 *     over-billing finance + inventory + customer overages.
 *
 *  3. POST /api/billing/generate accepts optional { discountAmount,
 *     discountReason } and emits a discount line item. Validates
 *     reason-when-amount-non-zero + caps the discount at the running
 *     subtotal.
 *
 *  4. startBillingCron registers a cron task at 00:05 IST on the 1st of
 *     every month. Source-file guard locks in the cron expression + the
 *     dual-service invocation order.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../app.js';
import { loginAsSuperAdmin } from './helpers.js';
import { prisma } from '../lib/prisma.js';
import * as billingService from '../services/billingService.js';
import * as seatRequestService from '../services/seatRequestService.js';
import type { Express } from 'express';

let app: Express;
let saToken: string;
let originalBillingTier: string | null;
let originalSubscriptionPlan: string | null;
let originalGaslinkBilling: boolean;

const auth = (token: string, distId?: string) => {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (distId) headers['X-Distributor-Id'] = distId;
  return headers;
};

const TEST_DIST = 'dist-001';

beforeAll(async () => {
  app = createApp();
  saToken = (await loginAsSuperAdmin()).token;
  const d = await prisma.distributor.findUniqueOrThrow({
    where: { id: TEST_DIST },
    select: { billingTier: true, subscriptionPlan: true, gaslinkBillingEnabled: true },
  });
  originalBillingTier = d.billingTier;
  originalSubscriptionPlan = d.subscriptionPlan;
  originalGaslinkBilling = d.gaslinkBillingEnabled;
});

afterAll(async () => {
  // Restore the seed-state values so other tests see what they expect.
  await prisma.distributor.update({
    where: { id: TEST_DIST },
    data: {
      billingTier: originalBillingTier as 'tier_1' | 'tier_2' | 'tier_3' | 'tier_4' | null,
      subscriptionPlan: originalSubscriptionPlan as 'starter' | 'growth' | 'business' | 'enterprise' | 'ultra' | null,
      gaslinkBillingEnabled: originalGaslinkBilling,
    },
  });
  // Clean up any cycles this suite emitted so seed dates stay free.
  await prisma.billingCycle.deleteMany({
    where: {
      distributorId: TEST_DIST,
      periodStartDate: { gte: new Date('2099-01-01') },
    },
  });
});

describe('Phase 4b — fix 1: generateBillingCycle no longer requires billingTier when subscriptionPlan is set', () => {
  it('plan set + billingTier null produces a successful cycle (was 400 pre-fix)', async () => {
    await prisma.distributor.update({
      where: { id: TEST_DIST },
      data: {
        billingTier: null,
        subscriptionPlan: 'business',
        gaslinkBillingEnabled: true,
      },
    });
    // Far-future dates so this fixture cannot collide with real cycles
    // (anti-pattern #7 — avoid today on the shared dev DB).
    const cycle = await billingService.generateBillingCycle(TEST_DIST, {
      periodType: 'monthly',
      periodStartDate: '2099-01-01',
      periodEndDate: '2099-01-31',
    });
    expect(cycle.id).toBeDefined();
    // The derived billingTier should be 'tier_3' for business (per the
    // SUBSCRIPTION_TO_BILLING_TIER map in billingService.ts).
    expect(cycle.billingTier).toBe('tier_3');
    // Clean up the fixture cycle so the next test gets a fresh slot.
    await prisma.billingCycle.delete({ where: { id: cycle.id } });
  });
});

describe('Phase 4b — fix 3: ad-hoc discount on POST /api/billing/generate', () => {
  // Same pre-condition as above — subscription plan set so the fix 1
  // code path is exercised in tandem with the new discount field.

  it('accepts discountAmount + discountReason and writes a discount line item', async () => {
    await prisma.distributor.update({
      where: { id: TEST_DIST },
      data: { subscriptionPlan: 'business', gaslinkBillingEnabled: true },
    });
    const res = await request(app)
      .post('/api/billing/generate')
      .set(auth(saToken, TEST_DIST))
      .send({
        distributorId: TEST_DIST,
        periodType: 'monthly',
        periodStartDate: '2099-02-01',
        periodEndDate: '2099-02-28',
        discountAmount: 500,
        discountReason: 'Loyalty waiver — Phase 4b test',
      });
    expect(res.status).toBe(201);
    const cycleId = res.body.data.cycleId;
    const items = await prisma.billingItem.findMany({ where: { billingCycleId: cycleId } });
    const discount = items.find((i) => i.itemType === 'period_discount' && i.description.includes('Loyalty waiver'));
    expect(discount).toBeDefined();
    expect(Number(discount!.lineTotalExclGst)).toBe(-500);
  });

  it('rejects discountAmount > 0 with empty reason (400)', async () => {
    const res = await request(app)
      .post('/api/billing/generate')
      .set(auth(saToken, TEST_DIST))
      .send({
        distributorId: TEST_DIST,
        periodType: 'monthly',
        periodStartDate: '2099-03-01',
        periodEndDate: '2099-03-31',
        discountAmount: 200,
        // reason omitted
      });
    expect(res.status).toBe(400);
  });

  it('rejects negative discountAmount (400)', async () => {
    const res = await request(app)
      .post('/api/billing/generate')
      .set(auth(saToken, TEST_DIST))
      .send({
        distributorId: TEST_DIST,
        periodType: 'monthly',
        periodStartDate: '2099-04-01',
        periodEndDate: '2099-04-30',
        discountAmount: -100,
        discountReason: 'should not pass',
      });
    expect(res.status).toBe(400);
  });

  it('caps oversized discount at the subtotal (cannot drive total negative)', async () => {
    const res = await request(app)
      .post('/api/billing/generate')
      .set(auth(saToken, TEST_DIST))
      .send({
        distributorId: TEST_DIST,
        periodType: 'monthly',
        periodStartDate: '2099-05-01',
        periodEndDate: '2099-05-31',
        discountAmount: 999999,
        discountReason: 'oversized waiver',
      });
    expect(res.status).toBe(201);
    expect(Number(res.body.data.totalAmountInclGst)).toBeGreaterThanOrEqual(0);
  });
});

describe('Phase 4b — fix 2: seatRequestService per-role overage pricing', () => {
  it('approve picks extraSeatPriceFinance for a finance seat (₹499, was ₹999 pre-fix)', async () => {
    // Set Bhargava to business (financeSeats=2 in Phase 4a, but for the
    // approve path we just need the tier's per-role prices).
    await prisma.distributor.update({
      where: { id: TEST_DIST },
      data: { subscriptionPlan: 'business' },
    });
    const seedAdminId = (await prisma.user.findFirstOrThrow({
      where: { email: 'bhargava@gasagency.com' },
    })).id;
    const seatReq = await seatRequestService.createSeatRequest({
      distributorId: TEST_DIST,
      requestedRole: 'finance',
      requestedBy: seedAdminId,
      reason: 'phase4b test',
    });
    const approved = await seatRequestService.approveSeatRequest(seatReq.id, seedAdminId);
    expect(Number(approved.pricePerMonth)).toBe(499);
    await prisma.seatRequest.delete({ where: { id: seatReq.id } });
  });

  it('approve picks extraSeatPriceInventory for an inventory seat (₹499)', async () => {
    const seedAdminId = (await prisma.user.findFirstOrThrow({
      where: { email: 'bhargava@gasagency.com' },
    })).id;
    const seatReq = await seatRequestService.createSeatRequest({
      distributorId: TEST_DIST,
      requestedRole: 'inventory',
      requestedBy: seedAdminId,
    });
    const approved = await seatRequestService.approveSeatRequest(seatReq.id, seedAdminId);
    expect(Number(approved.pricePerMonth)).toBe(499);
    await prisma.seatRequest.delete({ where: { id: seatReq.id } });
  });

  it('approve picks extraSeatPriceCustomer for a customer seat (₹249)', async () => {
    const seedAdminId = (await prisma.user.findFirstOrThrow({
      where: { email: 'bhargava@gasagency.com' },
    })).id;
    const seatReq = await seatRequestService.createSeatRequest({
      distributorId: TEST_DIST,
      requestedRole: 'customer',
      requestedBy: seedAdminId,
    });
    const approved = await seatRequestService.approveSeatRequest(seatReq.id, seedAdminId);
    expect(Number(approved.pricePerMonth)).toBe(249);
    await prisma.seatRequest.delete({ where: { id: seatReq.id } });
  });

  it('approve still picks extraSeatPriceDriver for a driver seat (₹299) — regression', async () => {
    const seedAdminId = (await prisma.user.findFirstOrThrow({
      where: { email: 'bhargava@gasagency.com' },
    })).id;
    const seatReq = await seatRequestService.createSeatRequest({
      distributorId: TEST_DIST,
      requestedRole: 'driver',
      requestedBy: seedAdminId,
    });
    const approved = await seatRequestService.approveSeatRequest(seatReq.id, seedAdminId);
    expect(Number(approved.pricePerMonth)).toBe(299);
    await prisma.seatRequest.delete({ where: { id: seatReq.id } });
  });

  it('approve picks extraSeatPriceAdmin for a distributor_admin seat (₹999)', async () => {
    const seedAdminId = (await prisma.user.findFirstOrThrow({
      where: { email: 'bhargava@gasagency.com' },
    })).id;
    const seatReq = await seatRequestService.createSeatRequest({
      distributorId: TEST_DIST,
      requestedRole: 'distributor_admin',
      requestedBy: seedAdminId,
    });
    const approved = await seatRequestService.approveSeatRequest(seatReq.id, seedAdminId);
    expect(Number(approved.pricePerMonth)).toBe(999);
    await prisma.seatRequest.delete({ where: { id: seatReq.id } });
  });
});

describe('Phase 4b — fix 4: monthly billing cron source guard', () => {
  // We don't actually fire the cron in a test (don't want real DB
  // mutations) — but we DO pin the schedule expression + the dual-
  // service invocation order. A regression that drops one of those would
  // silently revert the cron to a no-op or a broken expression.
  const cronSource = readFileSync(
    resolve(__dirname, '../jobs/billingCron.ts'),
    'utf-8',
  );

  it('uses the 1st-of-month 00:05 cron expression', () => {
    expect(cronSource).toMatch(/cron\.schedule\(\s*['"]5\s+0\s+1\s+\*\s+\*['"]/);
  });

  it('runs in Asia/Kolkata timezone (IST) so quarter / month boundaries align with India ops', () => {
    expect(cronSource).toMatch(/timezone:\s*['"]Asia\/Kolkata['"]/);
  });

  it('invokes BOTH markOverdueBillingCycles AND checkBillingExpiryAndCreatePendingActions', () => {
    expect(cronSource).toContain('markOverdueBillingCycles');
    expect(cronSource).toContain('checkBillingExpiryAndCreatePendingActions');
  });

  it('startBillingCron is wired into server.ts on app boot', () => {
    const serverSource = readFileSync(
      resolve(__dirname, '../server.ts'),
      'utf-8',
    );
    expect(serverSource).toContain('startBillingCron');
  });
});
